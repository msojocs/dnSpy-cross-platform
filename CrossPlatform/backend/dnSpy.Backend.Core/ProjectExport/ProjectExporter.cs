/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/MSBuildProjectCreator.cs and SolutionWriter.cs).

using System.Globalization;
using System.Text;
using System.Xml;
using ICSharpCode.Decompiler;
using dnlib.PE;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// dnSpy's MSBuildProjectCreator: one directory and project per module, every file of it written as a job on as many
/// threads as asked, then the project files, then the solution. A file that fails is logged and the others are still
/// written; a cancellation stops the export where it is. dnSpy.Console's export and the GUI's Export to Project both
/// run through this.
/// </summary>
public sealed class ProjectExporter(ProjectExportOptions options, IReadOnlyList<ProjectExportModule> modules, Action<string> error, IProjectExportProgress? progress = null) {
	readonly List<Project> projects = [];
	int totalProgress;

	/// <summary>The project files written, in the order the modules were given.</summary>
	public IReadOnlyList<string> ProjectFilenames => [.. projects.Select(project => project.Filename)];

	/// <summary>The solution's full path when one was asked for — dnSpy's MSBuildProjectCreator.SolutionFilename.</summary>
	public string? SolutionFilename => string.IsNullOrEmpty(options.SolutionFilename) ? null : Path.Combine(options.Directory, options.SolutionFilename);

	/// <summary>
	/// The C# settings a language is written from. Visual Basic is a conversion of C#, written from the settings the
	/// Visual Basic view decompiles with.
	/// </summary>
	public static DecompilerSettings SettingsForLanguage(DecompilerSettings source, bool visualBasic) {
		var settings = source.Clone();
		if (visualBasic)
			settings.ToVisualBasicSettings();
		return settings;
	}

	public async Task ExportAsync(CancellationToken cancellationToken) {
		if (string.IsNullOrEmpty(options.Directory))
			throw new InvalidOperationException("The export needs a destination folder.");
		AssignProjectGuids();
		using var satelliteAssemblyFinder = new SatelliteAssemblyFinder();
		try {
			var parallelOptions = new ParallelOptions {
				CancellationToken = cancellationToken,
				MaxDegreeOfParallelism = options.NumberOfThreads <= 0 ? Environment.ProcessorCount : options.NumberOfThreads,
			};
			var filenameCreator = new FilenameCreator(options.Directory);
			var ctx = new DecompileContext(cancellationToken, error);

			// dnSpy names the projects as its threads get to them; here they are named in the modules' order, so the
			// same export always gets the same directories.
			foreach (var module in modules) {
				cancellationToken.ThrowIfCancellationRequested();
				projects.Add(new Project(options, module, filenameCreator.Create(module.Module), satelliteAssemblyFinder));
			}
			await Parallel.ForEachAsync(projects, parallelOptions, (project, _) => {
				project.CreateProjectFiles(ctx);
				return ValueTask.CompletedTask;
			}).ConfigureAwait(false);

			var jobs = projects.SelectMany(project => project.GetJobs()).ToArray();
			var writeSolutionFile = SolutionFilename is not null;
			var maxProgress = jobs.Length + projects.Count + (writeSolutionFile ? 1 : 0);
			progress?.SetMaxProgress(maxProgress);

			await Parallel.ForEachAsync(jobs, parallelOptions, async (job, _) => {
				try {
					await job.CreateAsync(ctx).ConfigureAwait(false);
				}
				catch (OperationCanceledException) {
					throw;
				}
				catch (Exception ex) {
					if (job is IFileJob fileJob)
						error(string.Format(CultureInfo.CurrentCulture, "File creation failed ({0}), description = {1}, Exception message: {2}", fileJob.Filename, job.Description, ex.Message));
					else
						error(string.Format(CultureInfo.CurrentCulture, "Failed, description = {0}, Exception message: {1}", job.Description, ex.Message));
				}
				progress?.SetProgress(Interlocked.Increment(ref totalProgress));
			}).ConfigureAwait(false);

			await Parallel.ForEachAsync(projects, parallelOptions, (project, _) => {
				try {
					ProjectWriterBase writer = options.SdkProject
						? new SdkProjectWriter(project, options.ProjectVersion, projects, options.UserGacPaths)
						: new DefaultProjectWriter(project, options.ProjectVersion, projects, options.UserGacPaths);
					writer.Write();
				}
				catch (OperationCanceledException) {
					throw;
				}
				catch (Exception ex) {
					error(string.Format(CultureInfo.CurrentCulture, "Failed to create project file {0}, Exception message: {1}", project.Filename, ex.Message));
				}
				progress?.SetProgress(Interlocked.Increment(ref totalProgress));
				return ValueTask.CompletedTask;
			}).ConfigureAwait(false);

			if (writeSolutionFile) {
				cancellationToken.ThrowIfCancellationRequested();
				try {
					new SolutionWriter(options.ProjectVersion, projects, SolutionFilename!).Write();
				}
				catch (OperationCanceledException) {
					throw;
				}
				catch (Exception ex) {
					error(string.Format(CultureInfo.CurrentCulture, "Failed to create solution file {0}, Exception message: {1}", SolutionFilename, ex.Message));
				}
				progress?.SetProgress(Interlocked.Increment(ref totalProgress));
			}
			progress?.SetProgress(maxProgress);
		}
		finally {
			foreach (var project in projects)
				project.Decompiler.Dispose();
		}
	}

	/// <summary>
	/// dnSpy's ExportTask: with a project guid, the modules in path order get it and the guids that count on from
	/// its last eight hex digits; without one, every project gets a new guid.
	/// </summary>
	void AssignProjectGuids() {
		if (options.ProjectGuid is not { } projectGuid) {
			foreach (var module in modules)
				module.ProjectGuid = Guid.NewGuid();
			return;
		}
		var guidText = projectGuid.ToString();
		var number = uint.Parse(guidText.Substring(28, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
		var format = guidText[..28] + "{0:X8}";
		foreach (var module in modules.OrderBy(module => module.Module.Location, StringComparer.InvariantCultureIgnoreCase))
			module.ProjectGuid = new Guid(string.Format(CultureInfo.InvariantCulture, format, unchecked(number++)));
	}
}

/// <summary>The .sln the export writes beside its projects, or the .slnx form.</summary>
sealed class SolutionWriter {
	readonly ProjectVersion projectVersion;
	readonly List<Project> projects;
	readonly string filename;
	readonly List<string> configs = ["Debug", "Release"];
	readonly List<string?> platforms;

	public SolutionWriter(ProjectVersion projectVersion, IList<Project> projects, string filename) {
		this.projectVersion = projectVersion;
		this.projects = [.. projects];
		this.projects.Sort((a, b) => {
			// Sort exes first since VS picks the first file in the solution to be the "StartUp Project".
			var ae = (a.Module.Characteristics & Characteristics.Dll) == 0 ? 0 : 1;
			var be = (b.Module.Characteristics & Characteristics.Dll) == 0 ? 0 : 1;
			var c = ae.CompareTo(be);
			if (c != 0)
				return c;
			return StringComparer.OrdinalIgnoreCase.Compare(a.Filename, b.Filename);
		});
		this.filename = filename;

		var hash = new HashSet<string?>(projects.Select(a => a.Platform));
		platforms = new List<string?>(hash.Count) { "Any CPU" };
		hash.Remove("AnyCPU");
		if (hash.Count > 0)
			platforms.Add("Mixed Platforms");
		foreach (var p in hash)
			platforms.Add(p);
	}

	public void Write() {
		if (Path.GetExtension(filename) == ".slnx")
			WriteXmlSolution();
		else
			WriteVisualStudioSolution();
	}

	void WriteVisualStudioSolution() {
		Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
		using var writer = new StreamWriter(filename, false, Encoding.UTF8);
		const string crlf = "\r\n"; // Make sure it's always CRLF
		writer.Write(crlf);
		switch (projectVersion) {
		case ProjectVersion.VS2005:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 9.00" + crlf);
			writer.Write("# Visual Studio 2005" + crlf);
			break;
		case ProjectVersion.VS2008:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 10.00" + crlf);
			writer.Write("# Visual Studio 2008" + crlf);
			break;
		case ProjectVersion.VS2010:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 11.00" + crlf);
			writer.Write("# Visual Studio 2010" + crlf);
			break;
		case ProjectVersion.VS2012:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 2012" + crlf);
			break;
		case ProjectVersion.VS2013:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 2013" + crlf);
			writer.Write("VisualStudioVersion = 12.0.21005.1" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2015:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 14" + crlf);
			writer.Write("VisualStudioVersion = 14.0.23107.0" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2017:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 15" + crlf);
			writer.Write("VisualStudioVersion = 15.0.26228.4" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2019:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio Version 16" + crlf);
			writer.Write("VisualStudioVersion = 16.0.28729.10" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2022:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio Version 17" + crlf);
			writer.Write("VisualStudioVersion = 17.0.31903.59" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		default:
			throw new InvalidOperationException();
		}

		foreach (var p in projects) {
			writer.Write("Project(\"{0}\") = \"{1}\", \"{1}\\{2}\", \"{3}\"" + crlf,
				p.LanguageGuid.ToString("B").ToUpperInvariant(),
				Path.GetFileName(Path.GetDirectoryName(p.Filename)!),
				Path.GetFileName(p.Filename),
				p.Guid.ToString("B").ToUpperInvariant());
			writer.Write("EndProject" + crlf);
		}

		writer.Write("Global" + crlf);
		writer.Write("\tGlobalSection(SolutionConfigurationPlatforms) = preSolution" + crlf);
		foreach (var c in configs) {
			foreach (var p in platforms)
				writer.Write("\t\t{0}|{1} = {0}|{1}" + crlf, c, p);
		}
		writer.Write("\tEndGlobalSection" + crlf);

		writer.Write("\tGlobalSection(ProjectConfigurationPlatforms) = postSolution" + crlf);
		foreach (var p in projects) {
			var prjGuid = p.Guid.ToString("B").ToUpperInvariant();
			var pp = p.Platform == "AnyCPU" ? "Any CPU" : p.Platform;
			foreach (var c in configs) {
				foreach (var f in platforms) {
					writer.Write("\t\t{0}.{1}|{2}.ActiveCfg = {1}|{3}" + crlf, prjGuid, c, f, pp);
					writer.Write("\t\t{0}.{1}|{2}.Build.0 = {1}|{3}" + crlf, prjGuid, c, f, pp);
				}
			}
		}
		writer.Write("\tEndGlobalSection" + crlf);

		writer.Write("\tGlobalSection(SolutionProperties) = preSolution" + crlf);
		writer.Write("\t\tHideSolutionNode = FALSE" + crlf);
		writer.Write("\tEndGlobalSection" + crlf);

		writer.Write("EndGlobal" + crlf);
	}

	void WriteXmlSolution() {
		Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
		var settings = new XmlWriterSettings {
			Encoding = Encoding.UTF8,
			Indent = true,
			OmitXmlDeclaration = true,
		};
		using var writer = XmlWriter.Create(filename, settings);
		writer.WriteStartElement("Solution");
		if (platforms.Count != 1 || platforms[0] != "Any CPU") {
			writer.WriteStartElement("Configurations");
			foreach (var p in platforms) {
				if (p == "Mixed Platforms")
					continue;
				writer.WriteStartElement("Platform");
				writer.WriteAttributeString("Name", p);
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
		}
		foreach (var p in projects) {
			writer.WriteStartElement("Project");
			// The format's own separator, which the dotnet tools read on every system.
			var relativePath = Path.GetFileName(Path.GetDirectoryName(p.Filename)!) + "/" + Path.GetFileName(p.Filename);
			writer.WriteAttributeString("Path", relativePath);
			writer.WriteEndElement();
		}
		writer.WriteEndElement();
	}
}
