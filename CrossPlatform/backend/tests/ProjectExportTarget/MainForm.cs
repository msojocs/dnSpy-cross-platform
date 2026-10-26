using System.Windows.Forms;

namespace ProjectExportTarget;

public partial class MainForm : Form {
	public MainForm() => InitializeComponent();

	void Button1_Click(object? sender, EventArgs e) => Text = Strings.Greeting + Properties.Settings.Default.Greeting;

	internal static unsafe int Read(int* pointer) => *pointer;
}
