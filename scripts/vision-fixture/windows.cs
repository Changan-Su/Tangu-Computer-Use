using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;

// Only launched by the dedicated GitHub Windows desktop check. All observable
// outcomes come from native controls / mouse events, never a mocked helper.
public class WindowsVisionFixture : Form {
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    readonly string stateFile, commandFile;
    readonly ListBox list = new ListBox();
    readonly TextBox input = new TextBox();
    readonly Panel canvas = new Panel();
    readonly Form cover = new Form();
    readonly Timer timer = new Timer();
    Point start, last;
    int drags, presses;
    bool dragging;
    public WindowsVisionFixture(string state, string commands) {
        stateFile = state; commandFile = commands;
        Text = "Forsion CU Windows Fixture";
        StartPosition = FormStartPosition.Manual; Location = new Point(80, 80);
        ClientSize = new Size(660, 470);
        var button = new Button { Text = "Fixture button", AccessibleName = "Fixture button", Location = new Point(20, 15), Size = new Size(160, 35) };
        button.Click += (s, e) => presses++;
        input.AccessibleName = "Fixture input"; input.Text = "Initial";
        input.Location = new Point(200, 20); input.Size = new Size(250, 30);
        list.AccessibleName = "Native scroll list";
        list.Location = new Point(20, 85); list.Size = new Size(270, 350);
        for (int i = 0; i < 400; i++) list.Items.Add("Fixture row " + i);
        canvas.AccessibleName = "Native drawing canvas";
        canvas.Location = new Point(330, 85); canvas.Size = new Size(290, 350); canvas.BackColor = Color.White;
        canvas.MouseDown += (s, e) => { start = last = e.Location; dragging = true; canvas.Capture = true; };
        canvas.MouseMove += (s, e) => {
            if (!dragging) return;
            using (var graphics = canvas.CreateGraphics()) using (var pen = new Pen(Color.Blue, 3)) graphics.DrawLine(pen, last, e.Location);
            last = e.Location;
        };
        canvas.MouseUp += (s, e) => { if (dragging && Math.Abs(e.X - start.X) + Math.Abs(e.Y - start.Y) > 30) drags++; dragging = false; canvas.Capture = false; };
        Controls.AddRange(new Control[] { button, input, list, canvas });
        cover.Text = "Forsion CU Cover"; cover.StartPosition = FormStartPosition.Manual;
        cover.Location = new Point(800, 100); cover.Size = new Size(200, 180);
        timer.Interval = 100;
        timer.Tick += (s, e) => {
            // The PowerShell console starts hidden. Explicitly show this test
            // GUI after startup, rather than inheriting SW_HIDE for its first window.
            if (!IsWindowVisible(Handle)) { ShowWindow(Handle, 1); ActiveControl = list; list.Focus(); }
            if (File.Exists(commandFile)) {
                string command = File.ReadAllText(commandFile).Trim(); File.Delete(commandFile);
                if (command == "cover") {
                    cover.Show(); ShowWindow(cover.Handle, 9);
                    // Dedicated runner only: match the existing recorder probe's
                    // Alt/F24 foreground-lock workaround. This is fixture setup,
                    // before testing whether the agent preserves its foreground.
                    keybd_event(0x12, 0, 0, UIntPtr.Zero);
                    keybd_event(0x87, 0, 0, UIntPtr.Zero); keybd_event(0x87, 0, 2, UIntPtr.Zero);
                    keybd_event(0x12, 0, 2, UIntPtr.Zero);
                    SetForegroundWindow(cover.Handle); cover.Activate();
                }
                if (command == "target") Activate();
                if (command == "close") { Close(); return; }
            }
            var client = PointToScreen(Point.Empty);
            string text = input.Text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
            File.WriteAllText(stateFile + ".tmp", "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"hwnd\":" + Handle.ToInt64() + ",\"visible\":" + (IsWindowVisible(Handle) ? "true" : "false") + ",\"listFocused\":" + (list.Focused ? "true" : "false") + ",\"cover\":" + (cover.IsHandleCreated ? cover.Handle.ToInt64() : 0) + ",\"left\":" + Left + ",\"top\":" + Top + ",\"width\":" + Width + ",\"height\":" + Height + ",\"clientX\":" + client.X + ",\"clientY\":" + client.Y + ",\"topIndex\":" + list.TopIndex + ",\"drags\":" + drags + ",\"presses\":" + presses + ",\"input\":\"" + text + "\"}");
            if (File.Exists(stateFile)) File.Replace(stateFile + ".tmp", stateFile, null);
            else File.Move(stateFile + ".tmp", stateFile);
        };
        Shown += (s, e) => { list.Focus(); timer.Start(); };
        FormClosed += (s, e) => { timer.Stop(); cover.Dispose(); };
    }
    public static void Run(string state, string commands) {
        Application.EnableVisualStyles();
        Application.Run(new WindowsVisionFixture(state, commands));
    }
}
