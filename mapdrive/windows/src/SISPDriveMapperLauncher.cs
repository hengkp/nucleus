using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace SispDriveMapper
{
    internal static class Launcher
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory;
                string scriptPath = Path.Combine(appDir, "SISPDriveMapper.ps1");
                if (!File.Exists(scriptPath))
                {
                    MessageBox.Show("SISPDriveMapper.ps1 was not found in the install folder.", "SISP NAS Drive Mapper", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }

                string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\WindowsPowerShell\v1.0\powershell.exe");
                string arguments = "-NoProfile -STA -File " + Quote(scriptPath);
                foreach (string arg in args)
                {
                    arguments += " " + Quote(arg);
                }

                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = ps,
                    Arguments = arguments,
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                Process.Start(startInfo);
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "SISP NAS Drive Mapper", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
