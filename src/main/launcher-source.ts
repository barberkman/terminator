// Source for `terminator.exe`, the Windows launcher for the `terminator` command.
//
// Why a compiled launcher and not just terminator.cmd: a batch file re-parses its
// arguments. PowerShell hands one `say "hi" & go` and cmd drops the quotes or runs
// `go` as a second command — and the argument that matters most here is a free-form
// prompt. A console program receives its command line untouched, so this one passes
// the tail of it straight on to the app's own executable (run as Node) without
// reading a word of it; the CLI's parser sees exactly what PowerShell meant.
//
// It is also the console-subsystem program PowerShell waits for, which the app's
// exe (a GUI program) is not. The handles go across explicitly
// (STARTF_USESTDHANDLES): a GUI-subsystem child doesn't pick up its parent's pipes
// on its own, so `$id = terminator new …` would otherwise capture nothing.
//
// Built at runtime with the C# compiler every Windows has in its .NET Framework
// folder (cli-install.ts), so it needs no toolchain at build time and is rebuilt
// whenever this source changes. It reads `terminator.target` beside it — the app's
// exe, the CLI script and the user-data folder, one per line — which the app
// rewrites each time it starts, because a portable build moves every launch.

export const LAUNCHER_SOURCE = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  delegate bool CtrlHandler(int type);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(CtrlHandler h, bool add);
  [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();

  static IntPtr child = IntPtr.Zero;
  static CtrlHandler onCtrl; // held here so the GC can't collect it while Windows holds a pointer

  // Everything after the program's own name, exactly as it was typed. Windows ends
  // argv[0] at the closing quote when it starts with one, else at the first blank.
  static string Tail() {
    string line = Marshal.PtrToStringUni(GetCommandLineW()) ?? "";
    int i = 0;
    if (line.Length > 0 && line[0] == '"') {
      int close = line.IndexOf('"', 1);
      i = close < 0 ? line.Length : close + 1;
    } else {
      while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
    }
    return line.Substring(i);
  }

  static IntPtr Inheritable(int which) {
    IntPtr h = GetStdHandle(which);
    if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 1);
    return h;
  }

  static int Main() {
    string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    string[] target;
    try { target = File.ReadAllLines(Path.Combine(here, "terminator.target"), Encoding.UTF8); }
    catch { target = new string[0]; }
    if (target.Length < 3 || !File.Exists(target[0])) {
      Console.Error.WriteLine("Terminator isn't running.");
      return 1;
    }
    Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
    Environment.SetEnvironmentVariable("TERMINATOR_HOME", target[2]);

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = Inheritable(-10);
    si.hStdOutput = Inheritable(-11);
    si.hStdError = Inheritable(-12);
    StringBuilder cmd = new StringBuilder("\"" + target[0] + "\" \"" + target[1] + "\"" + Tail());
    PROCESS_INFORMATION pi;
    if (!CreateProcess(target[0], cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("Couldn't start Terminator's command (error " + Marshal.GetLastWin32Error() + ").");
      return 1;
    }
    child = pi.hProcess;
    // Ctrl+C ends the command, which drops its request — a 'wait' stops waiting.
    onCtrl = delegate (int type) { TerminateProcess(child, 130); return true; };
    SetConsoleCtrlHandler(onCtrl, true);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;
  }
}
`
