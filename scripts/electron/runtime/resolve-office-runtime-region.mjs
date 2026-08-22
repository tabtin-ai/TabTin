const CHINA_TIME_ZONES = new Set([
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Shanghai',
  'Asia/Urumqi',
]);

function localeRegion(locale) {
  try {
    return new Intl.Locale(locale).region?.toUpperCase() ?? '';
  } catch {
    return '';
  }
}

export function resolveOfficeRuntimeRegion({
  requested = process.env.TABTIN_RUNTIME_REGION ?? 'auto',
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  const normalized = String(requested).trim().toLowerCase();
  if (normalized === 'cn' || normalized === 'global') return normalized;
  if (normalized !== 'auto') {
    throw new Error(
      `Unsupported Office runtime region "${requested}"; expected auto, cn, or global.`,
    );
  }

  if (CHINA_TIME_ZONES.has(timeZone) || localeRegion(locale) === 'CN') {
    return 'cn';
  }
  return 'global';
}

function parseArgs(argv) {
  const options = { requested: process.env.TABTIN_RUNTIME_REGION ?? 'auto' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--region') {
      options.requested = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '--locale') {
      options.locale = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '--time-zone') {
      options.timeZone = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(
      resolveOfficeRuntimeRegion(parseArgs(process.argv.slice(2))),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
