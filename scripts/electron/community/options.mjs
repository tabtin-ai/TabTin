export function parseCommunityDevArgs(argv) {
  const options = {
    region: process.env.TABTIN_DEV_REGION || 'auto',
    skipBackend: false,
    doctor: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--region') {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
        throw new Error('Missing value for --region');
      }
      options.region = argv[index + 1];
      index += 1;
    } else if (argument === '--skip-backend') {
      options.skipBackend = true;
    } else if (argument === '--doctor') {
      options.doctor = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!['auto', 'cn', 'global'].includes(options.region)) {
    throw new Error('Region must be auto, cn, or global');
  }

  return options;
}

export function formatCommunityDevHelp() {
  return `Usage: node scripts/dev.mjs community [options]

Options:
  --region auto|cn|global  Download source strategy (default: auto)
  --skip-backend           Check, but do not start, the local backend
  --doctor                 Run environment checks only
  --dry-run                Print the execution plan without starting anything
  --help                   Show this help message`;
}
