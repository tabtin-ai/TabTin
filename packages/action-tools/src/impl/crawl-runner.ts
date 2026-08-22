import type { CrawlCleanHtmlInput, CrawlCleanHtmlOutput } from '../types';
import { t } from '../i18n';

export interface CrawlToolRunner {
  crawlCleanHtml(input: CrawlCleanHtmlInput): Promise<CrawlCleanHtmlOutput>;
  cleanup?(): Promise<void>;
}

export type CrawlToolRunnerFactory = (webContentsAdapter?: any) => CrawlToolRunner;

let crawlToolRunnerFactory: CrawlToolRunnerFactory | null = null;

export function setCrawlToolRunnerFactory(
  factory: CrawlToolRunnerFactory | null,
): void {
  crawlToolRunnerFactory = factory;
}

export function getCrawlToolRunnerFactory(): CrawlToolRunnerFactory | null {
  return crawlToolRunnerFactory;
}

export function getCrawlToolRunnerFactoryOrThrow(): CrawlToolRunnerFactory {
  if (!crawlToolRunnerFactory) {
    throw new Error(
      t('errors.crawlToolRunnerMissing')
    );
  }
  return crawlToolRunnerFactory;
}
