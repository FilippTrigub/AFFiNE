import { ApolloDriverConfig } from '@nestjs/apollo';

import { defineModuleConfig } from '../config';

declare global {
  interface AppConfigSchema {
    graphql: {
      apolloDriverConfig: ConfigItem<ApolloDriverConfig>;
    };
  }
}

defineModuleConfig('graphql', {
  apolloDriverConfig: {
    desc: 'The config for underlying nestjs GraphQL and apollo driver engine.',
    default: {
      // @TODO(@forehalo): need a flag to tell user `Restart Required` configs
      // Disabled by default: schema introspection is reachable without a session
      // (introspection resolves no user field, so AuthGuard never fires) and
      // hands an anonymous caller the full API surface. Re-enable per-deployment
      // if you need GraphQL tooling against a live server. Requires a restart.
      introspection: false,
    },
    link: 'https://docs.nestjs.com/graphql/quick-start',
  },
});
