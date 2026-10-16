import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/** Where the socket server lives. nginx proxies this path with the Upgrade headers; see the deploy notes. */
export const SOCKET_PATH = '/api/v1/socket.io';

/**
 * Socket.IO server options that have to match the HTTP side: the same allowed
 * origins as `enableCors`, and a path under the API prefix so one nginx
 * `location /api/` covers both.
 */
export class ChatIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      path: SOCKET_PATH,
      cors: { origin: this.allowedOrigins, credentials: true },
      // A chat message is at most a few KB of text; files go through POST /files/upload.
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25000,
      pingTimeout: 20000,
    });
  }
}
