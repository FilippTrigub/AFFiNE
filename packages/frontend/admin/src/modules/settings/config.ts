import { upperFirst } from 'lodash-es';
import type { ComponentType } from 'react';

import CONFIG_DESCRIPTORS from '../../config.json';
import type { ConfigInputProps } from './config-input-row';
import { AuthSigningKeys } from './operations/auth-signing-keys';
import { SendTestEmail } from './operations/send-test-email';
export type ConfigType = 'String' | 'Number' | 'Boolean' | 'JSON' | 'Enum';

type ConfigDescriptor = {
  desc: string;
  type: ConfigType;
  env?: string;
  link?: string;
};

export type AppConfig = Record<string, Record<string, any>>;

type AppConfigDescriptors = typeof CONFIG_DESCRIPTORS;
type AppConfigModule = keyof AppConfigDescriptors;
type ModuleConfigDescriptors<M extends AppConfigModule> =
  AppConfigDescriptors[M];
type ConfigGroup<T extends AppConfigModule> = {
  name: string;
  module: T;
  fields: Array<
    | keyof ModuleConfigDescriptors<T>
    | ({
        key: keyof ModuleConfigDescriptors<T>;
        sub?: string;
        desc?: string;
      } & Partial<ConfigInputProps>)
  >;
  operations?: ComponentType<{
    appConfig: AppConfig;
  }>[];
};
const IGNORED_MODULES: (keyof AppConfig)[] = [];

if (environment.isSelfHosted) {
  IGNORED_MODULES.push('payment', 'captcha', 'telemetry', 'metrics');
}

const ALL_CONFIGURABLE_MODULES = Object.keys(CONFIG_DESCRIPTORS).filter(
  key => !IGNORED_MODULES.includes(key as keyof AppConfig)
);

export const KNOWN_CONFIG_GROUPS = [
  {
    name: 'Server',
    module: 'server',
    fields: ['externalUrl', 'name', 'hosts'],
  } as ConfigGroup<'server'>,
  {
    name: 'Auth',
    module: 'auth',
    fields: [
      'allowSignup',
      'allowSignupForOauth',
      {
        key: 'allowedEmailDomains',
        type: 'EmailAllowlist',
        desc: 'Restrict account creation. With no rules anyone may sign up; with at least one rule, only a matching address may — on every path, including admin-created users and bulk imports. Existing accounts are never locked out, and never retroactively granted.',
      },
      {
        key: 'newAccountActionDelay',
        type: 'Number',
        desc: 'Minimum account age in seconds before accounts can invite members, create invite links, or publish documents. Set to 0 to disable.',
      },
      // nested json object
      {
        key: 'passwordRequirements',
        sub: 'min',
        type: 'Number',
        desc: 'Minimum length requirement of password',
      },
      {
        key: 'passwordRequirements',
        sub: 'max',
        type: 'Number',
        desc: 'Maximum length requirement of password',
      },
    ],
    operations: [AuthSigningKeys],
  } as ConfigGroup<'auth'>,
  {
    name: 'Guest Access',
    module: 'flags',
    fields: [
      {
        key: 'allowGuestDemoWorkspace',
        desc: 'Let signed-out visitors use a local demo workspace, seeded in their own browser from a bundled template. It holds no server data, but it does let anyone open the app. Turn this off to send signed-out visitors straight to the sign-in page.',
      },
    ],
  } as ConfigGroup<'flags'>,
  {
    name: 'Notification',
    module: 'mailer',
    fields: [
      'SMTP.name',
      'SMTP.host',
      'SMTP.port',
      'SMTP.username',
      'SMTP.password',
      'SMTP.ignoreTLS',
      'SMTP.sender',
    ],
    operations: [SendTestEmail],
  } as ConfigGroup<'mailer'>,
  {
    name: 'Storage',
    module: 'storages',
    fields: [
      {
        key: 'blob.storage',
        desc: 'The storage provider for user uploaded blobs',
        sub: 'provider',
        type: 'Enum',
        options: ['fs', 'aws-s3', 'cloudflare-r2'],
      },
      {
        key: 'blob.storage',
        sub: 'bucket',
        type: 'String',
        desc: 'The bucket name for user uploaded blobs storage',
      },
      {
        key: 'blob.storage',
        sub: 'config',
        type: 'JSON',
        desc: 'The S3 compatible config for the storage provider (endpoint/region/credentials).',
      },
      {
        key: 'avatar.storage',
        desc: 'The storage provider for user avatars',
        sub: 'provider',
        type: 'Enum',
        options: ['fs', 'aws-s3', 'cloudflare-r2'],
      },
      {
        key: 'avatar.storage',
        sub: 'bucket',
        type: 'String',
        desc: 'The bucket name for user avatars storage',
      },
      {
        key: 'avatar.storage',
        sub: 'config',
        type: 'JSON',
        desc: 'The S3 compatible config for the storage provider (endpoint/region/credentials).',
      },
      {
        key: 'avatar.publicPath',
        type: 'String',
        desc: 'The public path prefix for user avatars(e.g. https://my-bucket.s3.amazonaws.com/)',
      },
    ],
  } as ConfigGroup<'storages'>,
  {
    name: 'OAuth',
    module: 'oauth',
    fields: ['providers.google', 'providers.github', 'providers.oidc'],
  } as ConfigGroup<'oauth'>,
  {
    name: 'AI BYOK',
    module: 'copilot',
    fields: [
      {
        key: 'enabled',
        desc: 'Enable AI features. Workspace owners configure provider keys in Workspace Settings → Integrations → AI BYOK.',
      },
      'byok.enabled',
      'byok.allowedProviders',
      'byok.allowCustomEndpoint',
      {
        key: 'byok.allowPrivateEndpoint',
        desc: 'Allow workspace owners and admins to connect BYOK providers on private network endpoints. Only enable this for trusted workspaces.',
      },
    ],
  } as ConfigGroup<'copilot'>,
  {
    name: 'Indexer',
    module: 'indexer',
    fields: [
      {
        key: 'enabled',
        desc: 'Enable full-text indexing of workspace documents. Required for in-app document search and for the MCP doc_search tool; both fail with SEARCH_UNAVAILABLE while it is off. The default embedded provider needs no external service.',
      },
      {
        key: 'provider.type',
        type: 'Enum',
        options: ['embedded', 'elasticsearch', 'manticoresearch'],
        desc: 'Search provider. Embedded and Elasticsearch provide full search semantics; Manticore Search provides basic search semantics.',
      },
      'provider.endpoint',
      'provider.apiKey',
      'provider.username',
      'provider.password',
    ],
  } as ConfigGroup<'indexer'>,
  {
    name: 'MCP',
    module: 'mcp',
    fields: [
      {
        key: 'enabled',
        desc: 'Expose the workspace MCP endpoint at /api/workspaces/:workspaceId/mcp, letting external agents read and search docs with a per-workspace credential. Independent of AI / Copilot: no model provider or API key is required.',
      },
    ],
  } as ConfigGroup<'mcp'>,
];

export const UNKNOWN_CONFIG_GROUPS = ALL_CONFIGURABLE_MODULES.filter(
  module => !KNOWN_CONFIG_GROUPS.some(group => group.module === module)
).map(module => ({
  name: upperFirst(module),
  module,
  // @ts-expect-error allow
  fields: Object.keys(CONFIG_DESCRIPTORS[module]),
  operations: undefined,
}));

export const ALL_SETTING_GROUPS = [
  ...KNOWN_CONFIG_GROUPS,
  ...UNKNOWN_CONFIG_GROUPS,
];

export const ALL_CONFIG_DESCRIPTORS = CONFIG_DESCRIPTORS as Record<
  string,
  Record<string, ConfigDescriptor>
>;
