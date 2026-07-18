import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';
import {
  DEFAULT_MAX_RELEASE_BYTES,
  DEFAULT_MAX_STDIO_MESSAGE_BYTES,
  ReleaseRuntime,
  parseAllowedHostRule,
  readReleaseFile,
  serveStdio,
} from '@hi-mcp/runtime';

import { loadConfig } from './config.js';
import { compareReleaseToDocument, type ContractDiff } from './contract-diff.js';
import {
  createConnectionProfile,
  deriveApprovedOrigins,
  deriveCredentialBindings,
  exportMcpServersDescriptor,
  parseConnectionProfile,
  verifyConnectionProfileRelease,
  type CredentialBinding,
} from './connection-profile.js';
import { readJsonFile, readSourceInput, writeJsonAtomically } from './io.js';
import { PipelineError, analyzeSource, compileSource, validateRelease } from './pipeline.js';
import { ProfileEnvironmentCredentialProvider } from './profile-credentials.js';
import { writeHumanDiagnostics, writeJson, writeLine } from './output.js';
import { CLI_VERSION } from './version.js';

const DEFAULT_MAX_CONNECTION_PROFILE_BYTES = 1 * 1_024 * 1_024;

type DiffFailureThreshold = 'none' | 'breaking' | 'any';

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function diffFailureThreshold(value: string): DiffFailureThreshold {
  if (!['none', 'breaking', 'any'].includes(value)) {
    throw new InvalidArgumentError('Expected one of: none, breaking, any.');
  }
  return value as DiffFailureThreshold;
}

function diffFails(diff: ContractDiff, threshold: DiffFailureThreshold): boolean {
  if (threshold === 'none') return false;
  if (threshold === 'breaking') {
    return diff.summary.breaking > 0 || diff.summary.securityReview > 0;
  }
  return diff.summary.added + diff.summary.removed + diff.summary.changed > 0;
}

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function relativeArtifactPath(fromFile: string, targetFile: string): string {
  const path = relative(dirname(fromFile), targetFile);
  if (path === '') return './';
  return path.startsWith('.') ? path : `./${path}`;
}

function resolveProfileReleasePath(profileLocation: string, releasePath: string): string {
  return isAbsolute(releasePath) ? releasePath : resolve(dirname(profileLocation), releasePath);
}

function allowedHostsForOrigins(origins: readonly string[]) {
  const authorities = [...new Set(origins.map((origin) => new URL(origin).host))];
  return authorities.map(parseAllowedHostRule);
}

async function pathsAlias(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseCredentialEnvironmentOverrides(
  values: readonly string[],
  derivedBindings: readonly CredentialBinding[],
): readonly CredentialBinding[] {
  const overrides = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf('=');
    if (
      separator <= 0 ||
      separator === value.length - 1 ||
      value.indexOf('=', separator + 1) >= 0
    ) {
      throw new TypeError('--credential-env must use the exact <scheme>=<ENV_NAME> form.');
    }
    const scheme = value.slice(0, separator);
    const environmentVariable = value.slice(separator + 1);
    if (overrides.has(scheme)) {
      throw new TypeError(`Credential environment override for ${scheme} is duplicated.`);
    }
    overrides.set(scheme, environmentVariable);
  }

  const knownSchemes = new Set(derivedBindings.map(({ scheme }) => scheme));
  const unknownScheme = [...overrides.keys()].find((scheme) => !knownSchemes.has(scheme));
  if (unknownScheme !== undefined) {
    throw new TypeError(
      `Credential environment override references unknown or unused scheme ${unknownScheme}.`,
    );
  }
  return derivedBindings.map((binding) => ({
    ...binding,
    environmentVariable: overrides.get(binding.scheme) ?? binding.environmentVariable,
  }));
}

async function readJsonInput(location: string): Promise<unknown> {
  if (location !== '-') return readJsonFile(location);
  const input = await readSourceInput('-');
  return JSON.parse(input.content) as unknown;
}

async function readVerifiedConnectionProfile(
  profileLocation: string,
  maxReleaseBytes = DEFAULT_MAX_RELEASE_BYTES,
) {
  const profile = parseConnectionProfile(
    await readJsonFile(profileLocation, DEFAULT_MAX_CONNECTION_PROFILE_BYTES),
  );
  const releaseLocation = resolveProfileReleasePath(profileLocation, profile.release.path);
  const releaseValue = await readReleaseFile(releaseLocation, { maxBytes: maxReleaseBytes });
  const releaseValidation = await validateRelease({ value: releaseValue });
  if (!releaseValidation.valid || releaseValidation.release === undefined) {
    throw new PipelineError(
      'Connection profile references an invalid release.',
      releaseValidation.diagnostics,
    );
  }
  return {
    ...verifyConnectionProfileRelease(profile, releaseValidation.release),
    releaseLocation,
  };
}

export function createProgram(): Command {
  const program = new Command()
    .name('himcp')
    .description('Compile API contracts into verified, executable MCP capability releases.')
    .version(CLI_VERSION)
    .showHelpAfterError();

  program
    .command('analyze')
    .description('Detect and normalize an API source, then report capability coverage.')
    .argument('<source>', 'API source path, or - for stdin')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--source-type <adapter>', 'Source adapter id, or auto', 'auto')
    .option('--json', 'Write a machine-readable report', false)
    .action(
      async (
        sourceLocation: string,
        options: { config?: string; sourceType: string; json: boolean },
      ) => {
        const [{ content, location }, { config, location: configLocation }] = await Promise.all([
          readSourceInput(sourceLocation),
          loadConfig(options.config),
        ]);
        const result = await analyzeSource(content, location, config, options.sourceType);
        const document = result.adapter.document;
        const operations = document?.operations ?? [];
        const report = {
          sourceId: result.sourceId,
          adapter: result.adapter.adapterId,
          ...(result.sourceUri === undefined ? {} : { sourceUri: result.sourceUri }),
          ...(configLocation === undefined ? {} : { config: configLocation }),
          valid: !result.adapter.hasErrors,
          document:
            document === null
              ? null
              : {
                  title: document.title,
                  version: document.version,
                  sourceKind: document.sourceKind,
                  sourceVersion: document.sourceVersion,
                  ...(document.openapiVersion === undefined
                    ? {}
                    : { openapiVersion: document.openapiVersion }),
                  fingerprint: document.documentFingerprint,
                },
          operations: operations.length,
          candidates: operations.length,
          methods: Object.fromEntries(
            [...new Set(operations.map(({ method }) => method))]
              .sort()
              .map((method) => [
                method,
                operations.filter((operation) => operation.method === method).length,
              ]),
          ),
          diagnostics: result.adapter.diagnostics,
        };

        if (options.json) {
          writeJson(report);
        } else {
          writeHumanDiagnostics(result.adapter.diagnostics);
          writeLine(
            document === null
              ? 'API source analysis failed before normalization.'
              : `${document.title}: ${report.operations} operations, ${report.candidates} capability candidates, ${report.diagnostics.length} diagnostics.`,
          );
        }
        if (result.adapter.hasErrors) process.exitCode = 1;
      },
    );

  program
    .command('compile')
    .alias('register')
    .description('Compile and deterministically verify a registered API source.')
    .argument('<source>', 'API source path, or - for stdin')
    .option(
      '-o, --output <path>',
      'Release JSON destination, or - for stdout',
      'himcp.release.json',
    )
    .option('-c, --config <path>', 'Configuration file path')
    .option('--source-type <adapter>', 'Source adapter id, or auto', 'auto')
    .option(
      '--semantic',
      'Trust and execute providers from the explicitly supplied configuration',
      false,
    )
    .option('--sequence <number>', 'Non-negative release sequence', nonNegativeInteger, 0)
    .option('--force', 'Replace an existing release output file', false)
    .option('--json', 'Write a machine-readable compilation summary', false)
    .action(
      async (
        sourceLocation: string,
        options: {
          output: string;
          config?: string;
          sourceType: string;
          semantic: boolean;
          sequence: number;
          force: boolean;
          json: boolean;
        },
      ) => {
        const [{ content, location }, { config, location: configLocation }] = await Promise.all([
          readSourceInput(sourceLocation),
          loadConfig(options.config),
        ]);
        if (options.semantic && options.config === undefined) {
          throw new TypeError('--semantic requires an explicit --config path.');
        }
        if (options.semantic && !config.semantic.providers.some((provider) => provider.enabled)) {
          throw new TypeError('--semantic requires at least one enabled provider.');
        }
        const result = await compileSource({
          source: content,
          location,
          sourceType: options.sourceType,
          config,
          ...(configLocation === undefined ? {} : { configLocation }),
          semantic: options.semantic,
          sequence: options.sequence,
        });

        let outputLocation: string;
        if (options.output === '-') {
          writeJson(result.release);
          outputLocation = 'stdout';
        } else {
          if (sourceLocation !== '-' && (await pathsAlias(options.output, location))) {
            throw new TypeError('Release output cannot overwrite its API source.');
          }
          outputLocation = await writeJsonAtomically(options.output, result.release, {
            overwrite: options.force,
          });
        }

        const summary = {
          releaseId: result.release.id,
          fingerprint: result.release.fingerprint,
          output: outputLocation,
          capabilities: result.release.capabilities.length,
          diagnostics: result.diagnostics.length,
          semantic: result.semantic,
          ...(configLocation === undefined ? {} : { config: configLocation }),
        };
        if (options.output !== '-') {
          if (options.json) writeJson(summary);
          else {
            writeHumanDiagnostics(result.diagnostics);
            writeLine(
              `Compiled ${summary.capabilities} capabilities to ${outputLocation} (${summary.releaseId}).`,
            );
          }
        }
      },
    );

  program
    .command('diff')
    .description(
      'Compare a verified release with the deterministic contract from a current source.',
    )
    .argument('<release>', 'Verified baseline release JSON path, or - for stdin')
    .argument('<source>', 'Current API source path, or - for stdin')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--source-type <adapter>', 'Source adapter id, or auto', 'auto')
    .option(
      '--fail-on <threshold>',
      'Set a failing exit code for breaking/security changes or any change',
      diffFailureThreshold,
      'none',
    )
    .option('--json', 'Write the complete machine-readable contract diff', false)
    .action(
      async (
        releaseLocation: string,
        sourceLocation: string,
        options: {
          config?: string;
          sourceType: string;
          failOn: DiffFailureThreshold;
          json: boolean;
        },
      ) => {
        if (releaseLocation === '-' && sourceLocation === '-') {
          throw new TypeError('Release and source cannot both read from stdin.');
        }
        const [{ config }, releaseValue, source] = await Promise.all([
          loadConfig(options.config),
          readJsonInput(releaseLocation),
          readSourceInput(sourceLocation),
        ]);
        const baseline = await validateRelease({ value: releaseValue, config });
        if (!baseline.valid || baseline.release === undefined) {
          throw new PipelineError('The baseline release is invalid.', baseline.diagnostics);
        }
        const analysis = await analyzeSource(
          source.content,
          source.location,
          config,
          options.sourceType,
        );
        if (analysis.adapter.document === null || analysis.adapter.hasErrors) {
          throw new PipelineError(
            'The current API source could not be normalized safely.',
            analysis.adapter.diagnostics,
          );
        }
        const diff = compareReleaseToDocument(baseline.release, analysis.adapter.document);
        if (options.json) {
          writeJson(diff);
        } else {
          const { summary } = diff;
          writeLine(
            `Contract diff: ${summary.added} added, ${summary.removed} removed, ${summary.changed} changed, ${summary.unchanged} unchanged.`,
          );
          for (const change of diff.operations.filter(({ kind }) => kind !== 'unchanged')) {
            const operation = change.after ?? change.before;
            writeLine(
              `${change.impact.toUpperCase()} ${change.kind} ${change.operationId}${operation === undefined ? '' : ` (${operation.method} ${operation.path})`}${change.areas.length === 0 ? '' : `: ${change.areas.join(', ')}`}`,
            );
          }
        }
        if (diffFails(diff, options.failOn)) process.exitCode = 1;
      },
    );

  program
    .command('validate')
    .description('Validate release integrity and capability contracts.')
    .argument('<release>', 'Release JSON path, or - for stdin')
    .option('-s, --source <path>', 'Original API source for source-contract verification')
    .option('--source-type <adapter>', 'Source adapter id for --source, or auto', 'auto')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--strict', 'Treat warnings as a failing validation result', false)
    .option('--json', 'Write a machine-readable report', false)
    .action(
      async (
        releaseLocation: string,
        options: {
          source?: string;
          sourceType: string;
          config?: string;
          strict: boolean;
          json: boolean;
        },
      ) => {
        if (releaseLocation === '-' && options.source === '-') {
          throw new TypeError('Release and source cannot both read from stdin.');
        }
        const [{ config }, value, source] = await Promise.all([
          loadConfig(options.config),
          readJsonInput(releaseLocation),
          options.source === undefined
            ? Promise.resolve(undefined)
            : readSourceInput(options.source),
        ]);
        const result = await validateRelease({
          value,
          config,
          ...(source === undefined
            ? {}
            : {
                source: {
                  content: source.content,
                  location: source.location,
                  sourceType: options.sourceType,
                },
              }),
        });
        const warningCount = result.diagnostics.filter(
          ({ severity }) => severity === 'warning',
        ).length;
        const valid = result.valid && (!options.strict || warningCount === 0);
        const report = {
          valid,
          releaseId: result.release?.id,
          capabilities: result.release?.capabilities.length ?? 0,
          errors: result.diagnostics.filter(({ severity }) => severity === 'error').length,
          warnings: warningCount,
          diagnostics: result.diagnostics,
        };

        if (options.json) writeJson(report);
        else {
          writeHumanDiagnostics(result.diagnostics);
          writeLine(
            valid
              ? `Release ${report.releaseId ?? ''} is valid (${report.capabilities} capabilities).`
              : 'Release validation failed.',
          );
        }
        if (!valid) process.exitCode = 1;
      },
    );

  program
    .command('serve')
    .description('Serve a verified release over the MCP stdio transport.')
    .argument('<release>', 'Release JSON path')
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
    .option('--allow-insecure-http', 'Allow plain HTTP; private destinations remain blocked', false)
    .option('--server-index <number>', 'Zero-based server target index', nonNegativeInteger, 0)
    .option(
      '--max-release-bytes <bytes>',
      'Maximum release JSON file size in bytes',
      positiveInteger,
      DEFAULT_MAX_RELEASE_BYTES,
    )
    .option(
      '--max-stdio-message-bytes <bytes>',
      'Maximum inbound MCP JSON-line size in bytes before parsing',
      positiveInteger,
      DEFAULT_MAX_STDIO_MESSAGE_BYTES,
    )
    .action(
      async (
        releaseLocation: string,
        options: {
          allowConfirmationRequired: boolean;
          allowHost: readonly string[];
          trustCompiledHosts: boolean;
          allowInsecureHttp: boolean;
          serverIndex: number;
          maxReleaseBytes: number;
          maxStdioMessageBytes: number;
        },
      ) => {
        const allowedHosts = options.allowHost.map(parseAllowedHostRule);
        if (allowedHosts.length === 0 && !options.trustCompiledHosts) {
          throw new TypeError(
            'serve requires at least one --allow-host, or --trust-compiled-hosts for development.',
          );
        }
        const value = await readReleaseFile(releaseLocation, { maxBytes: options.maxReleaseBytes });
        const validation = await validateRelease({ value });
        if (!validation.valid || validation.release === undefined) {
          throw new PipelineError('Refusing to serve an invalid release.', validation.diagnostics);
        }
        const runtime = new ReleaseRuntime(validation.release, {
          policy: {
            allowConfirmationRequired: options.allowConfirmationRequired,
            trustCompiledHosts: options.trustCompiledHosts,
            execution: {
              allowInsecureHttp: options.allowInsecureHttp,
              serverIndex: options.serverIndex,
              ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
            },
          },
        });
        await serveStdio(runtime, CLI_VERSION, {
          maxMessageBytes: options.maxStdioMessageBytes,
        });
      },
    );

  const connection = program
    .command('connection')
    .description('Create and export a reviewed MCP connection profile for a verified release.');

  connection
    .command('create')
    .description('Bind a verified release to explicit destinations and runtime credentials.')
    .argument('<release>', 'Release JSON path')
    .requiredOption('--name <display-name>', 'Human-readable connection name')
    .option('--description <text>', 'Human-readable connection description')
    .option(
      '--approve-origin <origin>',
      'Approve one exact release origin; repeat for every release destination',
      collect,
      [],
    )
    .option(
      '--credential-env <scheme=ENV_NAME>',
      'Override the generated environment variable name for one auth scheme; repeat as needed',
      collect,
      [],
    )
    .option(
      '--approve-confirmation-required',
      'Coarsely approve all confirmation-required capabilities for this process',
      false,
    )
    .option('--allow-insecure-http', 'Allow reviewed plain-HTTP release origins', false)
    .option('--force', 'Replace an existing connection profile output file', false)
    .option(
      '-o, --output <path>',
      'Connection profile JSON destination, or - for stdout',
      'himcp.connection.json',
    )
    .option('--json', 'Write a machine-readable summary when output is a file', false)
    .action(
      async (
        releaseLocation: string,
        options: {
          name: string;
          description?: string;
          approveOrigin: readonly string[];
          credentialEnv: readonly string[];
          approveConfirmationRequired: boolean;
          allowInsecureHttp: boolean;
          output: string;
          force: boolean;
          json: boolean;
        },
      ) => {
        if (releaseLocation === '-') {
          throw new TypeError('Connection profiles require a persistent release file path.');
        }
        const absoluteReleaseLocation = resolve(releaseLocation);
        const value = await readReleaseFile(absoluteReleaseLocation, {
          maxBytes: DEFAULT_MAX_RELEASE_BYTES,
        });
        const validation = await validateRelease({ value });
        if (!validation.valid || validation.release === undefined) {
          throw new PipelineError(
            'Cannot create a connection for an invalid release.',
            validation.diagnostics,
          );
        }
        const release = validation.release;
        const releaseOrigins = deriveApprovedOrigins(release);
        if (options.approveOrigin.length === 0) {
          throw new TypeError(
            `Explicitly approve every release origin with --approve-origin (${releaseOrigins.join(', ')}).`,
          );
        }
        const outputLocation = options.output === '-' ? undefined : resolve(options.output);
        if (
          outputLocation !== undefined &&
          (await pathsAlias(outputLocation, absoluteReleaseLocation))
        ) {
          throw new TypeError('Connection profile output cannot overwrite its release file.');
        }
        const releasePath =
          outputLocation === undefined
            ? absoluteReleaseLocation
            : relativeArtifactPath(outputLocation, absoluteReleaseLocation);
        const bindings = parseCredentialEnvironmentOverrides(
          options.credentialEnv,
          deriveCredentialBindings(release),
        );
        const profile = createConnectionProfile({
          displayName: options.name,
          ...(options.description === undefined ? {} : { description: options.description }),
          release,
          releasePath,
          approvedOrigins: options.approveOrigin,
          allowInsecureHttp: options.allowInsecureHttp,
          confirmation: options.approveConfirmationRequired ? 'process' : 'per-call',
          credentialBindings: bindings,
        });
        const expectedOrigins = new Set(releaseOrigins);
        const approvedOrigins = new Set(profile.policy.approvedOrigins);
        if (
          expectedOrigins.size !== approvedOrigins.size ||
          [...expectedOrigins].some((origin) => !approvedOrigins.has(origin))
        ) {
          throw new TypeError(
            `Every and only release origin must be approved (${releaseOrigins.join(', ')}).`,
          );
        }

        if (outputLocation === undefined) {
          writeJson(profile);
          return;
        }
        await writeJsonAtomically(outputLocation, profile, { overwrite: options.force });
        const summary = {
          profileId: profile.id,
          fingerprint: profile.fingerprint,
          output: outputLocation,
          releaseId: profile.release.id,
          approvedOrigins: profile.policy.approvedOrigins,
          credentialEnvironment: Object.fromEntries(
            profile.credentialBindings.map(({ scheme, environmentVariable }) => [
              scheme,
              environmentVariable,
            ]),
          ),
          confirmation: profile.policy.confirmation,
        };
        if (options.json) writeJson(summary);
        else {
          writeLine(`Created connection profile ${profile.id} at ${outputLocation}.`);
          for (const { scheme, environmentVariable } of profile.credentialBindings) {
            writeLine(`Credential ${scheme}: set environment variable ${environmentVariable}.`);
          }
        }
      },
    );

  connection
    .command('export')
    .description('Export a product-neutral mcpServers launcher descriptor.')
    .argument('<profile>', 'Connection profile JSON path')
    .option('-o, --output <path>', 'Descriptor JSON destination, or - for stdout', '-')
    .option('--force', 'Replace an existing descriptor output file', false)
    .action(async (profileLocation: string, options: { output: string; force: boolean }) => {
      if (profileLocation === '-') {
        throw new TypeError('Connection export requires a persistent profile file path.');
      }
      const absoluteProfileLocation = resolve(profileLocation);
      const { profile, releaseLocation } =
        await readVerifiedConnectionProfile(absoluteProfileLocation);
      const descriptor = exportMcpServersDescriptor(profile, {
        nodePath: process.execPath,
        cliEntryPath: fileURLToPath(new URL('./bin.js', import.meta.url)),
        profilePath: absoluteProfileLocation,
      });
      if (options.output === '-') {
        writeJson(descriptor);
      } else {
        if (
          (await pathsAlias(options.output, absoluteProfileLocation)) ||
          (await pathsAlias(options.output, releaseLocation))
        ) {
          throw new TypeError(
            'Descriptor output cannot overwrite its connection profile or referenced release.',
          );
        }
        const outputLocation = await writeJsonAtomically(options.output, descriptor, {
          overwrite: options.force,
        });
        writeLine(`Exported MCP launcher descriptor to ${outputLocation}.`);
      }
    });

  program
    .command('serve-profile')
    .description('Serve a verified connection profile over the MCP stdio transport.')
    .argument('<profile>', 'Connection profile JSON path')
    .option(
      '--max-release-bytes <bytes>',
      'Maximum release JSON file size in bytes',
      positiveInteger,
      DEFAULT_MAX_RELEASE_BYTES,
    )
    .option(
      '--max-stdio-message-bytes <bytes>',
      'Maximum inbound MCP JSON-line size in bytes before parsing',
      positiveInteger,
      DEFAULT_MAX_STDIO_MESSAGE_BYTES,
    )
    .action(
      async (
        profileLocation: string,
        options: { maxReleaseBytes: number; maxStdioMessageBytes: number },
      ) => {
        if (profileLocation === '-') {
          throw new TypeError('Profile serving requires a persistent profile file path.');
        }
        const absoluteProfileLocation = resolve(profileLocation);
        const { profile, release } = await readVerifiedConnectionProfile(
          absoluteProfileLocation,
          options.maxReleaseBytes,
        );
        const runtime = new ReleaseRuntime(release, {
          executionDependencies: {
            credentialProvider: new ProfileEnvironmentCredentialProvider(profile),
          },
          policy: {
            allowConfirmationRequired: profile.policy.confirmation === 'process',
            executionForCapability(capability) {
              const server = capability.execution.servers[0];
              if (server === undefined) {
                throw new TypeError('Capability has no executable server target.');
              }
              const origin = new URL(server.resolvedUrl ?? server.template).origin;
              if (!profile.policy.approvedOrigins.includes(origin)) {
                throw new TypeError(
                  'Capability destination origin is not approved by the profile.',
                );
              }
              return {
                allowedHosts: allowedHostsForOrigins([origin]),
                allowInsecureHttp: profile.policy.allowInsecureHttp && origin.startsWith('http://'),
              };
            },
          },
        });
        await serveStdio(runtime, CLI_VERSION, {
          maxMessageBytes: options.maxStdioMessageBytes,
        });
      },
    );

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof PipelineError) writeHumanDiagnostics(error.diagnostics);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  }
}
