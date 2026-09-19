import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  EventBus,
  getClientVersionFromRequest,
  getRequestCookie,
} from '../../base';
import { isNativeClientRequest } from './input';
import { AuthService } from './service';
import type { CurrentUser } from './session';

export type SessionIssueInput =
  | { type: 'native'; clientVersion?: string }
  | { type: 'cookie'; sessionId?: string; clientVersion?: string };

export type NativeLoginResult = {
  user: CurrentUser;
  sessionId?: string;
  sessionExpiresAt?: string;
  exchangeCode?: string;
  created?: boolean;
};

@Injectable()
export class SessionIssuer {
  constructor(
    private readonly auth: AuthService,
    private readonly event: EventBus
  ) {}

  target(req: Request, clientVersion?: string): SessionIssueInput {
    const version =
      clientVersion ?? getClientVersionFromRequest(req) ?? undefined;
    if (isNativeClientRequest(req)) {
      return { type: 'native', clientVersion: version };
    }
    return {
      type: 'cookie',
      sessionId:
        req.authType === 'jwt'
          ? req.session?.sessionId
          : getRequestCookie(req, AuthService.sessionCookieName),
      clientVersion: version,
    };
  }

  apply(res: Response, result: NativeLoginResult) {
    // Users created by the Rust runtime — OAuth and magic link — never pass
    // through `models/user.ts`, so `user.created` does not fire for them. This
    // is the one point every such sign-in reaches, before the native-client
    // branch below returns early.
    if (result.created) {
      this.event.emitDetached('user.signedUp', {
        id: result.user.id,
        email: result.user.email,
      });
    }
    if (result.exchangeCode) {
      this.auth.clearCookies(res);
      return;
    }
    if (!result.sessionId || !result.sessionExpiresAt) {
      throw new Error('Native login result did not include a cookie session.');
    }
    const expires = new Date(result.sessionExpiresAt);
    res.cookie(AuthService.sessionCookieName, result.sessionId, {
      ...this.auth.cookieOptions,
      expires,
    });
    res.cookie(AuthService.csrfCookieName, randomUUID(), {
      ...this.auth.cookieOptions,
      httpOnly: false,
      expires,
    });
    this.auth.setUserCookie(res, result.user.id);
  }
}
