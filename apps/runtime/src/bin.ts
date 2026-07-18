#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import { parseAllowedHostRule } from './host-rule.js';
import { DEFAULT_MAX_RELEASE_BYTES, readReleaseFile } from './release-file.js';
import { ReleaseRuntime } from './runtime.js';
import { DEFAULT_MAX_STDIO_MESSAGE_BYTES, serveStdio } from './stdio.js';
import { RUNTIME_VERSION } from './version.js';

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

const program = new Command()
  .name('himcp-runtime')
  .description('Run a verified HiMCP release over the MCP stdio transport.')
  .version(RUNTIME_VERSION)
  .argument('<release>', 'Path to a compiled HiMCP release JSON file')
  .option(
    '--allow-confirmation-required',
    'Coarsely approve all capabilities whose verified risk contract requires confirmation',
    false,
  )
  .option(
    '--allow-host <hostname[:port]>',
    'Allow an exact upstream hostname and optional port; repeat for multiple destinations',
    collect,
    [],
  )
  .option(
    '--trust-compiled-hosts',
    'Development only: trust destination hosts embedded in the compiled release',
    false,
  )
  .option(
    '--allow-insecure-http',
    'Allow HTTP destinations; private networks remain blocked',
    false,
  )
  .option('--server-index <index>', 'Select a server target by zero-based index', '0')
  .option(
    '--max-release-bytes <bytes>',
    'Maximum release JSON file size in bytes',
    String(DEFAULT_MAX_RELEASE_BYTES),
  )
  .option(
    '--max-stdio-message-bytes <bytes>',
    'Maximum inbound MCP JSON-line size in bytes before parsing',
    String(DEFAULT_MAX_STDIO_MESSAGE_BYTES),
  )
  .action(
    async (
      releaseLocation: string,
      options: {
        allowConfirmationRequired: boolean;
        allowInsecureHttp: boolean;
        serverIndex: string;
        maxReleaseBytes: string;
        maxStdioMessageBytes: string;
        allowHost: readonly string[];
        trustCompiledHosts: boolean;
      },
    ) => {
      const serverIndex = Number(options.serverIndex);
      if (!Number.isSafeInteger(serverIndex) || serverIndex < 0) {
        throw new TypeError('--server-index must be a non-negative integer.');
      }
      const maxReleaseBytes = Number(options.maxReleaseBytes);
      const maxStdioMessageBytes = Number(options.maxStdioMessageBytes);
      const allowedHosts = options.allowHost.map(parseAllowedHostRule);
      if (allowedHosts.length === 0 && !options.trustCompiledHosts) {
        throw new TypeError(
          'At least one --allow-host is required unless --trust-compiled-hosts is explicitly enabled.',
        );
      }
      const release = await readReleaseFile(resolve(releaseLocation), {
        maxBytes: maxReleaseBytes,
      });
      const runtime = new ReleaseRuntime(release, {
        policy: {
          allowConfirmationRequired: options.allowConfirmationRequired,
          trustCompiledHosts: options.trustCompiledHosts,
          execution: {
            allowInsecureHttp: options.allowInsecureHttp,
            serverIndex,
            ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
          },
        },
      });
      await serveStdio(runtime, RUNTIME_VERSION, { maxMessageBytes: maxStdioMessageBytes });
    },
  );

await program.parseAsync(process.argv);
