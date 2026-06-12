import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { PaymentConfigService } from './payment-config.services';

describe('PaymentConfigService admin updates', () => {
  let temporaryDirectory: string;
  let configPath: string;
  let service: PaymentConfigService;

  beforeEach(async () => {
    temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'payment-config-'),
    );
    configPath = path.join(temporaryDirectory, 'config.yml');
    process.env.PAYMENT_CONFIG_PATH = configPath;
    await fs.promises.writeFile(
      configPath,
      YAML.stringify({
        bots: {},
        webhooks: { test: { url: 'http://localhost' } },
        proxies: {},
        gateways: {
          mb_bank_1: {
            type: 'MBBANK',
            account: '123456',
            password: 'secret',
            enabled: true,
          },
        },
      }),
    );
    service = new PaymentConfigService();
  });

  afterEach(async () => {
    delete process.env.PAYMENT_CONFIG_PATH;
    await fs.promises.rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('toggles a gateway without removing credentials or other config', async () => {
    await service.setGatewayEnabled('mb_bank_1', false);
    const config = await service.getConfig();

    expect(config.gateways.mb_bank_1.enabled).toBe(false);
    expect(config.gateways.mb_bank_1.password).toBe('secret');
    expect(config.webhooks.test.url).toBe('http://localhost');
  });

  it('adds a gateway using structured YAML output', async () => {
    await service.upsertGateway('acb_shop_1', {
      type: 'ACBBANK',
      account: '654321',
      enabled: true,
    });
    const config = await service.getConfig();

    expect(config.gateways.acb_shop_1).toEqual({
      type: 'ACBBANK',
      account: '654321',
      enabled: true,
    });
  });
});
