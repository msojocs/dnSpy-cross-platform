#nullable enable
using System.ComponentModel;
using System.Windows.Forms;

namespace ProjectExportTarget;

partial class MainForm {
	private IContainer? components = null;

	protected override void Dispose(bool disposing) {
		if (disposing && components != null)
			components.Dispose();
		base.Dispose(disposing);
	}

	private void InitializeComponent() {
		button1 = new Button();
		SuspendLayout();
		button1.Text = "OK";
		button1.Click += new EventHandler(Button1_Click);
		Controls.Add(button1);
		ResumeLayout(false);
	}

	private Button button1 = null!;
}
