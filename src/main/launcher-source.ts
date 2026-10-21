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
// exe (a GUI program) is not — and the one that owns the output. The child writes
// into plain pipes, and this copies their bytes on to its own stdout and stderr,
// whatever those are: a console, a PowerShell pipe, a file, or the handles WSL's
// interop hands a Windows program, which Node in the GUI-subsystem exe can't open
// when given them directly. Copied as bytes, so `reply > x.md` gets exactly the
// UTF-8 the command wrote.
//
// Built at runtime with the C# compiler every Windows has in its .NET Framework
// folder (cli-install.ts), so it needs no toolchain at build time and is rebuilt
// whenever this source changes. It reads `terminator.target` beside it — the app's
// exe, the CLI script and the user-data folder, one per line — which the app
// rewrites each time it starts, because a portable build moves every launch.

export const LAUNCHER_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Launcher {
  [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();

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

  // Copy one of the child's pipes onto one of ours, byte for byte, as it arrives.
  static Thread Pump(Stream from, Stream to) {
    Thread t = new Thread(delegate () {
      byte[] buf = new byte[65536];
      try {
        int n;
        while ((n = from.Read(buf, 0, buf.Length)) > 0) {
          to.Write(buf, 0, n);
          to.Flush();
        }
      } catch (IOException) {
        // the reader went away: nothing left to deliver
      }
    });
    t.IsBackground = true;
    t.Start();
    return t;
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
    // Inherited by the child; set here rather than through StartInfo, whose
    // environment table lower-cases every name it copies.
    Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
    Environment.SetEnvironmentVariable("TERMINATOR_HOME", target[2]);

    // Arguments goes onto the command line as given: the tail, untouched.
    ProcessStartInfo start = new ProcessStartInfo(target[0], "\"" + target[1] + "\"" + Tail());
    start.UseShellExecute = false;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    Process child;
    try { child = Process.Start(start); }
    catch (Exception e) {
      Console.Error.WriteLine("Couldn't start Terminator's command: " + e.Message);
      return 1;
    }

    // Ctrl+C ends the command, which drops its request — a 'wait' stops waiting.
    bool cancelled = false;
    Console.CancelKeyPress += delegate (object sender, ConsoleCancelEventArgs e) {
      e.Cancel = true;
      cancelled = true;
      try { child.Kill(); } catch { }
    };

    Thread outPump = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
    Thread errPump = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
    child.WaitForExit();
    outPump.Join();
    errPump.Join();
    return cancelled ? 130 : child.ExitCode;
  }
}
`
