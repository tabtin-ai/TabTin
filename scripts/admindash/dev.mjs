#!/usr/bin/env node
import { runViteDev } from '../shared/vite-dev.mjs';

runViteDev({
  filter: 'admindash',
  port: 5174,
  label: 'AdminDash 运营管理后台',
});
