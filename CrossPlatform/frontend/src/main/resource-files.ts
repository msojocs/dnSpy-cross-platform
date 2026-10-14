// What dnSpy's SaveResources.GetFiles names the files it writes a resource to.

// The characters no file name may hold on any of the three platforms — Windows' list, which is the longest —
// each written as "_", the way dnSpy's FixFileNamePart writes the ones .NET calls invalid.
const INVALID_FILE_NAME_CHARACTERS = /[<>:"|?*\\/\x00-\x1f]/g

const fixFileNamePart = (part: string): string => part.replace(INVALID_FILE_NAME_CHARACTERS, '_')

/** The name a resource saves under on its own: the part of its name after the last directory separator. */
export const resourceFileName = (name: string): string =>
  fixFileNamePart(name.split(/[\\/]/).at(-1) ?? name) || 'resource.bin'

/**
 * Where a resource goes inside the folder several are saved to, as path segments. dnSpy's plain variant writes
 * every one of them straight into the folder under its file name; the "use sub dirs" variant keeps the
 * directories its name has. A segment that would climb out of the folder — "." or ".." — is written as a name
 * of its own instead, so a resource cannot put a file anywhere but under the folder the user picked.
 */
export const resourceFileSegments = (name: string, useSubDirs: boolean): string[] => {
  if (!useSubDirs)
    return [resourceFileName(name)]
  const segments = name.split(/[\\/]/).map((part) => part === '.' || part === '..' ? part.replace(/\./g, '_') : fixFileNamePart(part)).filter((part) => part.length > 0)
  return segments.length > 0 ? segments : ['resource.bin']
}
