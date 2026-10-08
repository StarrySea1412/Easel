// Built with the .NET Framework compiler supplied by Windows 10/11.
// Keep argument construction independent of cmd.exe and PowerShell.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class PortableArguments
{
    public static string Quote(string value)
    {
        if (value == null) throw new ArgumentNullException("value");
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(character);
            }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    public static string CommandLine(string root, string action)
    {
        if (action != "start" && action != "stop" && action != "status")
            throw new ArgumentException("Unsupported portable action");
        string[] values = { "-I", "-B", Path.Combine(root, "app", "scripts", "portable_launcher.py"),
            action, "--root", root, "--no-browser", "--json" };
        return String.Join(" ", Array.ConvertAll(values, Quote));
    }

    public static bool WorkbenchUrl(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "http"
            && uri.Host == "127.0.0.1" && uri.Port > 0 && uri.Port <= 65535
            && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0
            && uri.AbsolutePath == "/";
    }

    public static bool CanCloseWithoutRuntime(string root, bool runtimeInvoked)
    {
        if (runtimeInvoked) return false;
        if (File.Exists(Path.Combine(root, "runtime", "python", "python.exe"))
            && File.Exists(Path.Combine(root, "app", "scripts", "portable_launcher.py"))) return false;
        try
        {
            // Even an invalid/empty record requires the runtime's ownership
            // checks. Do not inspect its contents or stop any process here.
            File.GetAttributes(Path.Combine(root, "data", "portable-processes.json"));
            return false;
        }
        catch (FileNotFoundException) { return true; }
        catch (DirectoryNotFoundException) { return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
}

internal sealed class PortableResult
{
    internal bool Ok;
    internal bool Running;
    internal bool GatewayRunning;
    internal bool WebRunning;
    internal string Message;
    internal string Url;
    internal string LogPath;

    internal static PortableResult FromPayload(Dictionary<string, object> data, int exitCode)
    {
        object ok, running, serviceValue;
        bool succeeded = exitCode == 0 && data.TryGetValue("ok", out ok) && ok is bool && (bool)ok;
        Dictionary<string, object> services = data.TryGetValue("services", out serviceValue)
            ? serviceValue as Dictionary<string, object> : null;
        if (data.ContainsKey("services") && services == null) succeeded = false;
        object gateway, web;
        return new PortableResult { Ok = succeeded,
            Running = data.TryGetValue("running", out running) && running is bool && (bool)running,
            GatewayRunning = services != null && services.TryGetValue("gateway", out gateway) && gateway is bool && (bool)gateway,
            WebRunning = services != null && services.TryGetValue("web", out web) && web is bool && (bool)web,
            Message = TextValue(data, "message"), Url = TextValue(data, "url"), LogPath = TextValue(data, "logPath") };
    }

    private static string TextValue(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value is string ? (string)value : null;
    }
}

internal sealed class PortableWindow : Form
{
    private readonly string root;
    private readonly Label state = new Label();
    private readonly Label explanation = new Label();
    private readonly LinkLabel address = new LinkLabel();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Button start = new Button();
    private readonly Button open = new Button();
    private readonly Button stop = new Button();
    private readonly Button logs = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private bool busy;
    private bool closeRequested;
    private bool canClose;
    private bool hasStarted;
    private bool runtimeInvoked;
    private string url;
    private string logPath;

    internal PortableWindow(string bundleRoot)
    {
        root = bundleRoot;
        Text = "Easel 便携版";
        Font = new Font("Microsoft YaHei UI", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 310);
        MinimumSize = new Size(580, 340);
        MaximizeBox = false;
        BackColor = Color.FromArgb(249, 248, 246);

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.Padding = new Padding(28);
        layout.ColumnCount = 1;
        layout.RowCount = 6;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 43));
        Controls.Add(layout);

        state.Text = "正在准备工作台…";
        state.Font = new Font(Font.FontFamily, 15F, FontStyle.Bold);
        state.Dock = DockStyle.Fill;
        state.TextAlign = ContentAlignment.MiddleLeft;
        layout.Controls.Add(state, 0, 0);
        explanation.Text = "所有运行工具都在此文件夹中。首次启动会准备本副本的数据，请稍候。";
        explanation.Dock = DockStyle.Fill;
        explanation.AutoEllipsis = true;
        explanation.AccessibleName = "运行状态说明";
        layout.Controls.Add(explanation, 0, 1);
        address.Dock = DockStyle.Fill;
        address.AccessibleName = "工作台地址";
        address.LinkClicked += delegate { OpenWorkbench(); };
        layout.Controls.Add(address, 0, 2);
        progress.Dock = DockStyle.Fill;
        progress.Style = ProgressBarStyle.Marquee;
        progress.MarqueeAnimationSpeed = 35;
        layout.Controls.Add(progress, 0, 3);
        Label hint = new Label();
        hint.Dock = DockStyle.Fill;
        hint.Text = "保持此窗口打开。退出时会停止本副本的服务；个人资料保存在 data 文件夹。";
        hint.ForeColor = Color.FromArgb(90, 89, 85);
        hint.Padding = new Padding(0, 13, 0, 0);
        layout.Controls.Add(hint, 0, 4);

        FlowLayoutPanel buttons = new FlowLayoutPanel();
        buttons.Dock = DockStyle.Fill;
        buttons.WrapContents = false;
        start.Text = "启动";
        open.Text = "打开工作台";
        stop.Text = "停止服务";
        logs.Text = "查看日志";
        foreach (Button button in new Button[] { start, open, stop, logs })
        {
            button.AutoSize = true;
            button.MinimumSize = new Size(112, 34);
            button.Margin = new Padding(0, 0, 8, 0);
            buttons.Controls.Add(button);
        }
        start.Click += delegate { RunAction("start", true); };
        open.Click += delegate { OpenWorkbench(); };
        stop.Click += delegate { RunAction("stop", true); };
        logs.Click += delegate { OpenLogs(); };
        layout.Controls.Add(buttons, 0, 5);
        timer.Interval = 15000;
        timer.Tick += delegate { if (!busy && !closeRequested) RunAction("status", false); };
        Shown += delegate { timer.Start(); RunAction("start", true); };
        FormClosing += Closing;
    }

    private void SetBusy(bool value, bool visibleProgress)
    {
        busy = value;
        progress.Visible = value && visibleProgress;
        start.Enabled = !value && !closeRequested;
        stop.Enabled = !value && !closeRequested;
        open.Enabled = !closeRequested && PortableArguments.WorkbenchUrl(url);
    }

    private void RunAction(string action, bool showProgress)
    {
        if (busy) return;
        SetBusy(true, showProgress);
        if (showProgress)
        {
            state.Text = action == "stop" ? "正在停止服务…" : "正在启动工作台…";
            explanation.Text = action == "stop" ? "正在关闭本文件夹启动的服务，请稍候。"
                : "首次启动可能需要几分钟。无需安装工具，请保持此窗口打开。";
        }
        Task.Factory.StartNew(delegate { return InvokeLauncher(action); }).ContinueWith(task =>
        {
            if (IsDisposed) return;
            BeginInvoke((Action)delegate
            {
                PortableResult result = task.IsFaulted
                    ? new PortableResult { Ok = false, Message = task.Exception.GetBaseException().Message }
                    : task.Result;
                SetBusy(false, false);
                ApplyResult(action, result);
                if (closeRequested)
                {
                    if (PortableArguments.CanCloseWithoutRuntime(root, runtimeInvoked)
                        || (action == "stop" && result.Ok && !result.Running && !result.GatewayRunning && !result.WebRunning))
                    {
                        canClose = true;
                        Close();
                    }
                    else if (action == "stop")
                    {
                        closeRequested = false;
                        SetBusy(false, false);
                        timer.Start();
                        MessageBox.Show(this, "未能停止本副本服务。请查看日志后重试，控制窗口将保持打开。",
                            "Easel", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                    else RunAction("stop", true);
                }
            });
        });
    }

    private PortableResult InvokeLauncher(string action)
    {
        string python = Path.Combine(root, "runtime", "python", "python.exe");
        string launcher = Path.Combine(root, "app", "scripts", "portable_launcher.py");
        if (!File.Exists(python) || !File.Exists(launcher))
            return new PortableResult { Ok = false, Message = "运行文件缺失。请将 ZIP 完整解压后再双击 Easel.exe。" };
        ProcessStartInfo info = new ProcessStartInfo(python, PortableArguments.CommandLine(root, action));
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["PYTHONUTF8"] = "1";
        using (Process process = Process.Start(info))
        {
            runtimeInvoked = true;
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(action == "start" ? 360000 : 60000))
            {
                // Startup owns a lock while it records its children. Killing it
                // here could lose the records required for a safe later stop.
                BeginInvoke((Action)delegate
                {
                    state.Text = "等待服务响应…";
                    explanation.Text = "当前检查耗时较长，可以查看日志。退出请求将在检查结束后安全执行。";
                });
                process.WaitForExit();
            }
            string stdout = output.Result;
            string stderr = error.Result;
            string[] lines = stdout.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                if (!lines[i].TrimStart().StartsWith("{")) continue;
                try
                {
                    Dictionary<string, object> data = serializer.Deserialize<Dictionary<string, object>>(lines[i]);
                    return PortableResult.FromPayload(data, process.ExitCode);
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
            }
            string details = String.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
            if (details.Length > 1500) details = details.Substring(details.Length - 1500);
            return new PortableResult { Ok = false, Message = String.IsNullOrWhiteSpace(details)
                ? "服务未返回有效状态，请查看日志。" : details.Trim() };
        }
    }

    private void ApplyResult(string action, PortableResult result)
    {
        if (!String.IsNullOrWhiteSpace(result.LogPath)) logPath = result.LogPath;
        if (result.Ok && result.Running && PortableArguments.WorkbenchUrl(result.Url))
        {
            url = result.Url;
            address.Text = url;
            state.Text = "工作台已就绪";
            explanation.Text = "现在可以开始创作。模型服务和平台账号可在工作台中配置。";
            open.Enabled = !closeRequested;
            start.Enabled = false;
            if (action == "start" && !hasStarted && !closeRequested) OpenWorkbench();
            hasStarted = true;
        }
        else if (result.GatewayRunning || result.WebRunning)
        {
            url = result.WebRunning && PortableArguments.WorkbenchUrl(result.Url) ? result.Url : null;
            address.Text = url ?? "";
            open.Enabled = !closeRequested && url != null;
            hasStarted = false;
            state.Text = "部分服务仍在运行";
            explanation.Text = "工作台尚未完整就绪。请先停止服务，再移动文件夹；可查看日志后重新启动。";
        }
        else if (result.Ok && !result.Running)
        {
            url = null;
            address.Text = "";
            open.Enabled = false;
            hasStarted = false;
            state.Text = "服务已停止";
            explanation.Text = "个人资料已保留。点击启动可继续使用；现在也可以移动整个文件夹。";
        }
        else
        {
            state.Text = "需要处理";
            explanation.Text = String.IsNullOrWhiteSpace(result.Message) ? "启动未完成，请查看日志后重试。" : result.Message;
            explanation.AccessibleDescription = explanation.Text;
        }
    }

    private void OpenWorkbench()
    {
        if (!PortableArguments.WorkbenchUrl(url)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { explanation.Text = "无法打开默认浏览器：" + error.Message; }
    }

    private void OpenLogs()
    {
        try
        {
            string data = Path.GetFullPath(Path.Combine(root, "data"));
            string candidate = String.IsNullOrWhiteSpace(logPath) ? Path.Combine(data, "logs") : Path.GetFullPath(logPath);
            if (!candidate.StartsWith(data + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                candidate = data;
            if (File.Exists(candidate)) candidate = Path.GetDirectoryName(candidate);
            if (!Directory.Exists(candidate)) candidate = Directory.Exists(data) ? data : root;
            Process.Start(new ProcessStartInfo("explorer.exe", PortableArguments.Quote(candidate)) { UseShellExecute = true });
        }
        catch (Exception error) { explanation.Text = "无法打开日志文件夹：" + error.Message; }
    }

    private void Closing(object sender, FormClosingEventArgs args)
    {
        if (canClose) { timer.Stop(); return; }
        if (!busy && PortableArguments.CanCloseWithoutRuntime(root, runtimeInvoked))
        {
            timer.Stop();
            canClose = true;
            return;
        }
        args.Cancel = true;
        if (closeRequested) return;
        closeRequested = true;
        timer.Stop();
        if (busy)
        {
            state.Text = "正在准备退出…";
            explanation.Text = "当前检查结束后将停止本副本服务，再关闭窗口。";
        }
        else RunAction("stop", true);
    }
}

internal static class PortableEntry
{
    [STAThread]
    private static void Main()
    {
        string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        if (root.Length > Path.GetPathRoot(root).Length) root = root.TrimEnd(Path.DirectorySeparatorChar);
        string identity;
        using (SHA256 sha = SHA256.Create())
            identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "");
        bool created;
        using (Mutex instance = new Mutex(true, "Local\\EaselPortable-" + identity, out created))
        {
            if (!created)
            {
                MessageBox.Show("这个文件夹的 Easel 控制窗口已经打开。请使用已有窗口。", "Easel");
                return;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new PortableWindow(root));
            }
            finally { instance.ReleaseMutex(); }
        }
    }
}
