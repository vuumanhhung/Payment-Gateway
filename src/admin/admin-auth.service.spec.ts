import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminAuthService } from './admin-auth.service';

describe('AdminAuthService', () => {
  let temporaryDirectory: string;
  let service: AdminAuthService;

  beforeEach(async () => {
    temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'payment-admin-'),
    );
    process.env.ADMIN_DATA_PATH = path.join(temporaryDirectory, 'admin.json');
    service = new AdminAuthService({
      get: jest.fn((key: string) => (key === 'PORT' ? 3001 : undefined)),
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    delete process.env.ADMIN_DATA_PATH;
    await fs.promises.rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('creates a persistent random secret path and hashed password config', async () => {
    await service.onApplicationBootstrap();
    const storedConfig = JSON.parse(
      await fs.promises.readFile(process.env.ADMIN_DATA_PATH, 'utf-8'),
    );

    expect(service.getSecretPath()).toMatch(/^[a-zA-Z0-9]{24}$/);
    expect(storedConfig.passwordHash).toMatch(/^[a-f0-9]{128}$/);
    expect(storedConfig.password).toBeUndefined();
    expect(storedConfig.sessionSecret).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a valid signed session and rejects a modified token', async () => {
    await service.onApplicationBootstrap();
    const token = service['createSessionToken']();
    const request = {
      headers: { cookie: `payment_admin_session=${token}` },
    } as Request;

    expect(service.isAuthenticated(request, service.getSecretPath())).toBe(
      true,
    );

    request.headers.cookie = `payment_admin_session=${token}modified`;
    expect(service.isAuthenticated(request, service.getSecretPath())).toBe(
      false,
    );
  });
});
