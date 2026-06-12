import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

type AdminConfig = {
  secretPath: string;
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
  createdAt: string;
};

type LoginAttempt = {
  count: number;
  blockedUntil: number;
};

const scrypt = promisify(scryptCallback);

@Injectable()
export class AdminAuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly cookieName = 'payment_admin_session';
  private readonly sessionDurationSeconds = 8 * 60 * 60;
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private adminConfig: AdminConfig;

  constructor(private readonly configService: ConfigService) {}

  async onApplicationBootstrap() {
    const configPath = this.getConfigPath();
    await fs.promises.mkdir(path.dirname(configPath), {
      recursive: true,
      mode: 0o700,
    });

    try {
      this.adminConfig = JSON.parse(
        await fs.promises.readFile(configPath, 'utf-8'),
      );
      this.logger.log(`Admin URL: ${this.getAdminUrl()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.createAdminConfig(configPath);
    }
  }

  getSecretPath() {
    return this.adminConfig.secretPath;
  }

  isSecretPath(secretPath: string) {
    return this.safeEqual(secretPath, this.adminConfig.secretPath);
  }

  assertSecretPath(secretPath: string) {
    if (!this.isSecretPath(secretPath)) {
      throw new UnauthorizedException();
    }
  }

  async login(password: string, clientKey: string) {
    this.assertLoginAllowed(clientKey);
    const passwordHash = await this.hashPassword(
      password || '',
      this.adminConfig.passwordSalt,
    );

    if (!this.safeEqual(passwordHash, this.adminConfig.passwordHash)) {
      this.recordFailedLogin(clientKey);
      throw new UnauthorizedException('Mật khẩu không đúng');
    }

    this.loginAttempts.delete(clientKey);
    return this.createSessionToken();
  }

  isAuthenticated(request: Request, secretPath: string) {
    if (!this.isSecretPath(secretPath)) return false;
    const token = this.getCookie(request, this.cookieName);
    return token ? this.verifySessionToken(token) : false;
  }

  assertAuthenticated(request: Request, secretPath: string) {
    if (!this.isAuthenticated(request, secretPath)) {
      throw new UnauthorizedException();
    }
  }

  getSessionCookie(token: string, secure: boolean) {
    return [
      `${this.cookieName}=${token}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${this.sessionDurationSeconds}`,
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  getExpiredSessionCookie(secure: boolean) {
    return [
      `${this.cookieName}=`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=0',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  private async createAdminConfig(configPath: string) {
    const password = this.randomAlphaNumeric(18);
    const passwordSalt = randomBytes(16).toString('hex');
    this.adminConfig = {
      secretPath: this.randomAlphaNumeric(24),
      passwordSalt,
      passwordHash: await this.hashPassword(password, passwordSalt),
      sessionSecret: randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };

    await fs.promises.writeFile(
      configPath,
      JSON.stringify(this.adminConfig, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );

    this.logger.warn('Admin credentials were generated for the first time.');
    this.logger.warn(`Admin URL: ${this.getAdminUrl()}`);
    this.logger.warn(`Admin password: ${password}`);
    this.logger.warn(
      'Mật khẩu chỉ hiện lần này. Xóa .admin-data/admin.json để tạo lại.',
    );
  }

  private getConfigPath() {
    return (
      process.env.ADMIN_DATA_PATH ||
      path.join(process.cwd(), '.admin-data', 'admin.json')
    );
  }

  private getAdminUrl() {
    const port = this.configService.get('PORT') || process.env.PORT || 3000;
    return `http://localhost:${port}/${this.adminConfig.secretPath}`;
  }

  private async hashPassword(password: string, salt: string) {
    const result = (await scrypt(password, salt, 64)) as Buffer;
    return result.toString('hex');
  }

  private createSessionToken() {
    const payload = Buffer.from(
      JSON.stringify({
        issuedAt: Date.now(),
        nonce: randomBytes(16).toString('hex'),
      }),
    ).toString('base64url');
    const signature = this.sign(payload);
    return `${payload}.${signature}`;
  }

  private verifySessionToken(token: string) {
    const [payload, signature] = token.split('.');
    if (
      !payload ||
      !signature ||
      !this.safeEqual(this.sign(payload), signature)
    ) {
      return false;
    }

    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return (
        typeof parsed.issuedAt === 'number' &&
        parsed.issuedAt <= Date.now() &&
        Date.now() - parsed.issuedAt < this.sessionDurationSeconds * 1000
      );
    } catch {
      return false;
    }
  }

  private sign(payload: string) {
    return createHmac('sha256', this.adminConfig.sessionSecret)
      .update(payload)
      .digest('hex');
  }

  private getCookie(request: Request, name: string) {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return undefined;

    for (const cookie of cookieHeader.split(';')) {
      const [key, ...value] = cookie.trim().split('=');
      if (key === name) return value.join('=');
    }
    return undefined;
  }

  private assertLoginAllowed(clientKey: string) {
    const attempt = this.loginAttempts.get(clientKey);
    if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) {
      throw new UnauthorizedException(
        'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.',
      );
    }
  }

  private recordFailedLogin(clientKey: string) {
    const current = this.loginAttempts.get(clientKey);
    const count = (current?.count || 0) + 1;
    this.loginAttempts.set(clientKey, {
      count,
      blockedUntil: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
    });
  }

  private randomAlphaNumeric(length: number) {
    const alphabet =
      'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = randomBytes(length);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(
      '',
    );
  }

  private safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left || '');
    const rightBuffer = Buffer.from(right || '');
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
