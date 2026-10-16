import { getCurrentUserQuery } from '@affine/graphql';
import type { RawBodyRequest } from '@nestjs/common';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';

import { configureBodyParsers } from '../../../server';
import { Mockers } from '../../mocks';
import { app, e2e } from '../test';

e2e('should create test app correctly', async t => {
  t.truthy(app);
});

e2e('should mock mails work', async t => {
  t.is(app.mails.count('MemberInvitation'), 0);
});

e2e('should handle http request', async t => {
  const res = await app.GET('/info');
  t.is(res.status, 200);
  t.is(res.body.compatibility, env.version);
});

for (const [serverPath, prefix] of [
  ['', ''],
  ['///', ''],
  ['/affine.v1/', '/affine.v1'],
  ['///affine.v1///', '/affine.v1'],
  ['affine//nested', '/affine//nested'],
]) {
  e2e(
    `attachment body limit follows server prefix ${serverPath || '/'}`,
    async t => {
      const module = await Test.createTestingModule({}).compile();
      const http = module.createNestApplication<NestExpressApplication>({
        logger: false,
        rawBody: true,
      });
      configureBodyParsers(http, serverPath);
      http.use((req: RawBodyRequest<Request>, res: Response) =>
        res.json({ size: req.body.length, raw: req.rawBody?.equals(req.body) })
      );
      await http.init();
      await http.listen(0);
      try {
        const large = Buffer.alloc(21 * 1024 * 1024);
        for (const attachmentPath of [
          `${prefix}/api/copilot/chat/session/attachments/key`,
          `${prefix}/API/COPILOT/CHAT/session/attachments/key/?upload=1`,
        ]) {
          const response = await request(http.getHttpServer())
            .put(attachmentPath)
            .set('content-type', 'application/octet-stream')
            .send(large);
          t.is(response.status, 413);
        }
        const accepted = await request(http.getHttpServer())
          .put(`${prefix}/api/copilot/chat/session/attachments/key`)
          .set('content-type', 'application/octet-stream')
          .send(Buffer.alloc(1024));
        t.is(accepted.status, 200);
        t.is(accepted.body.size, 1024);
        t.true(accepted.body.raw);
        const other = await request(http.getHttpServer())
          .put(`${prefix}/api/workspaces/blob`)
          .set('content-type', 'application/octet-stream')
          .send(large);
        t.is(other.status, 200);
        t.is(other.body.size, large.length);
      } finally {
        await http.close();
      }
    }
  );
}

e2e(
  'MCP requests may carry a full-size image, other JSON stays capped',
  async t => {
    // A controller, not a bare middleware: Nest mounts its global parsers in
    // init(), ahead of controller routes, which is what production relies on.
    @Controller()
    class EchoController {
      @Post(['graphql', 'api/workspaces/:workspaceId/mcp'])
      @HttpCode(200)
      echo(@Body() body: unknown) {
        return { size: JSON.stringify(body ?? null).length };
      }
    }
    const module = await Test.createTestingModule({
      controllers: [EchoController],
    }).compile();
    const http = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureBodyParsers(http, '');
    await http.init();
    await http.listen(0);
    try {
      // upload_image takes up to 10 MB, which is ~13.4 MB as base64.
      const image = { data_base64: 'A'.repeat(14 * 1024 * 1024) };
      const accepted = await request(http.getHttpServer())
        .post('/api/workspaces/ws/mcp')
        .send(image);
      t.is(accepted.status, 200);
      t.true(accepted.body.size > 14 * 1024 * 1024);

      const tooLarge = await request(http.getHttpServer())
        .post('/api/workspaces/ws/mcp')
        .send({ data_base64: 'A'.repeat(17 * 1024 * 1024) });
      t.is(tooLarge.status, 413);

      // Every other route must still get Nest's global JSON parser.
      const small = { query: '{ serverConfig { version } }' };
      const parsed = await request(http.getHttpServer())
        .post('/graphql')
        .send(small);
      t.is(parsed.status, 200);
      t.is(parsed.body.size, JSON.stringify(small).length);

      const elsewhere = await request(http.getHttpServer())
        .post('/graphql')
        .send({ data: 'A'.repeat(1024 * 1024) });
      // Nest's default parser still refuses it (this bare app reports 500).
      t.true(elsewhere.status >= 400);
    } finally {
      await http.close();
    }
  }
);

e2e('should create workspace with owner', async t => {
  const user = await app.signup();
  const workspace = await app.create(Mockers.Workspace, {
    owner: { id: user.id },
  });
  t.truthy(workspace);
});

e2e('should get current user', async t => {
  const user = await app.signup();
  await app.switchUser(user);
  const res = await app.gql({ query: getCurrentUserQuery });
  t.truthy(res.currentUser);
  t.is(res.currentUser!.id, user.id);
});
