using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Windows.Forms;

namespace SispDriveMapper
{
    internal static class Uninstaller
    {
        private const string AppName = "SISP NAS Drive Mapper";

        [STAThread]
        private static int Main(string[] args)
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string innoUninstaller = Path.Combine(appDir, "unins000.exe");

            if (File.Exists(innoUninstaller))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = innoUninstaller,
                    Arguments = JoinArgs(args),
                    UseShellExecute = true
                });
                return 0;
            }

            DialogResult answer = MessageBox.Show(
                "The standard uninstaller was not found. Remove the per-user SISP Drive Mapper shortcuts, protocol handler, and install folder?",
                AppName,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes)
            {
                return 0;
            }

            try
            {
                StopRunningMapper();
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AppName + ".lnk"));
                DeleteIfExists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));

                string startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "SISP");
                DeleteIfExists(Path.Combine(startMenuDir, AppName + ".lnk"));
                DeleteIfExists(Path.Combine(startMenuDir, "Uninstall " + AppName + ".lnk"));

                TryDeleteRegistryTree(Registry.CurrentUser, @"Software\Classes\sispdrive");
                TryDeleteRegistryTree(Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\SISPDriveMapper");

                ScheduleDirectoryRemoval(appDir, startMenuDir);
                MessageBox.Show(AppName + " was removed.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static string JoinArgs(string[] args)
        {
            string joined = "";
            foreach (string arg in args)
            {
                if (joined.Length > 0) joined += " ";
                joined += "\"" + arg.Replace("\"", "\\\"") + "\"";
            }
            return joined;
        }

        private static void StopRunningMapper()
        {
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='powershell.exe' OR Name='pwsh.exe'"))
                {
                    foreach (ManagementObject process in searcher.Get())
                    {
                        string commandLine = Convert.ToString(process["CommandLine"]);
                        if (commandLine.IndexOf("SISPDriveMapper.ps1", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            Process.GetProcessById(Convert.ToInt32(process["ProcessId"])).Kill();
                        }
                    }
                }
            }
            catch
            {
            }
        }

        private static void DeleteIfExists(string path)
        {
            if (File.Exists(path)) File.Delete(path);
        }

        private static void TryDeleteRegistryTree(RegistryKey root, string subkey)
        {
            try { root.DeleteSubKeyTree(subkey, false); } catch { }
        }

        private static void ScheduleDirectoryRemoval(string appDir, string startMenuDir)
        {
            string command = "/c timeout /t 2 /nobreak > nul & rmdir /s /q " + Quote(appDir);
            if (Directory.Exists(startMenuDir) && Directory.GetFileSystemEntries(startMenuDir).Length == 0)
            {
                command += " & rmdir /q " + Quote(startMenuDir);
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = command,
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true
            });
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
