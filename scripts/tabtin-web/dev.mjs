#!/usr/bin/env node
import { runViteDev } from '../shared/vite-dev.mjs';

runViteDev({
  filter: 'tabtin-web',
  port: Number(process.env.VITE_TABTIN_WEB_DEV_PORT ?? 5176),
  label: 'tabtin-web 云端桌面',
});
