// Launch Services normally resolves names in the current system language. Also
// consult the names the installed bundles publish for other languages.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const lookup = `
ObjC.import('AppKit');
function run(argv) {
  const name = argv[0];
  const fm = $.NSFileManager.defaultManager, ws = $.NSWorkspace.sharedWorkspace;
  const normalize = s => s.normalize('NFC').toLowerCase().replace(/\\.app$/, '');
  function id(path) {
    if (!path) return null;
    const bundle = $.NSBundle.bundleWithPath(path);
    return bundle.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier) || null;
  }
  if (name.startsWith('/')) return JSON.stringify([id(name)].filter(Boolean));
  const direct = ObjC.unwrap(ws.fullPathForApplication(name));
  if (direct && id(direct)) return JSON.stringify([id(direct)]);
  const roots = new Set(['/Applications', '/Applications/Utilities', '/System/Applications',
    '/System/Applications/Utilities', ObjC.unwrap($.NSHomeDirectory()) + '/Applications']);
  const bundles = new Set();
  for (const app of ObjC.unwrap(ws.runningApplications)) {
    if (app.bundleURL.isNil()) continue;
    const path = ObjC.unwrap(app.bundleURL.path);
    if (path) bundles.add(path);
  }
  for (const root of roots) {
    for (const file of ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(root, null)) || [])
      if (/\\.app$/i.test(file)) bundles.add(root + '/' + file);
  }
  const ids = new Set(), wanted = normalize(name);
  function matches(props) {
    return !props.isNil() && ['CFBundleDisplayName', 'CFBundleName'].some(key => {
      const value = ObjC.unwrap(props.objectForKey(key));
      return typeof value === 'string' && normalize(value) === wanted;
    });
  }
  for (const path of bundles) {
    const bundle = $.NSBundle.bundleWithPath(path);
    if (bundle.isNil()) continue;
    const table = $.NSDictionary.dictionaryWithContentsOfFile(path + '/Contents/Resources/InfoPlist.loctable');
    if (!table.isNil() && ObjC.unwrap(table.allValues).some(props => props.respondsToSelector('objectForKey:') && matches(props))) {
      const bid = id(path);
      if (bid) ids.add(bid);
      continue;
    }
    const locales = ObjC.deepUnwrap(bundle.localizations) || [];
    for (const lang of locales) {
      const file = path + '/Contents/Resources/' + lang + '.lproj/InfoPlist.strings';
      const props = $.NSDictionary.dictionaryWithContentsOfFile(file);
      if (matches(props)) {
        const bid = id(path);
        if (bid) ids.add(bid);
        break;
      }
    }
  }
  return JSON.stringify(Array.from(ids));
}`;

export async function macAppIdentifiers(name: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lookup, '--', name], { signal, timeout: 5000 });
  return JSON.parse(stdout);
}

/** A bundle identifier alone cannot distinguish independently installed copies. */
export async function macAppPathPids(path: string, signal?: AbortSignal): Promise<number[]> {
  const script = `ObjC.import('AppKit'); function run(argv) {
    const requested = ObjC.unwrap($.NSURL.fileURLWithPath(argv[0]).URLByResolvingSymlinksInPath.path);
    return JSON.stringify(ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications)
      .filter(a => !a.bundleURL.isNil() && ObjC.unwrap(a.bundleURL.URLByResolvingSymlinksInPath.path) === requested)
      .map(a => a.processIdentifier));
  }`;
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, '--', path], { signal, timeout: 3000 });
  return JSON.parse(stdout);
}

export async function macScreenLocked(signal?: AbortSignal): Promise<boolean> {
  // CGSessionCopyCurrentDictionary returns a CF reference in JXA.
  const script = `ObjC.import('CoreGraphics');
    const session = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
    ObjC.deepUnwrap(session)?.CGSSessionScreenIsLocked === true;`;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { signal, timeout: 2000 });
    return stdout.trim() === 'true';
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
