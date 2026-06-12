import { Injectable } from '@nestjs/common';
import * as YAML from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PaymentConfigService {
  private writeQueue: Promise<void> = Promise.resolve();

  getConfigFilePath() {
    return (
      process.env.PAYMENT_CONFIG_PATH ||
      path.join(process.cwd(), 'config', 'config.yml')
    );
  }

  async getConfig() {
    const pathConfig = this.getConfigFilePath();
    const configText = await fs.promises.readFile(pathConfig, 'utf-8');
    const config = YAML.parse(configText);
    return config;
  }

  async getConfigPath<T>(key: 'bots' | 'webhooks' | 'gateways' | 'proxies') {
    const ymlConfig = await this.getConfig();

    const ymlWebhooks = ymlConfig[key] as {
      [key: string]: Omit<T, 'name'>;
    };

    if (!ymlWebhooks) return [];

    const webhooksConfig = Object.keys(ymlWebhooks).map((key) => ({
      name: key,
      ...ymlWebhooks[key],
    }));

    return webhooksConfig as T[];
  }

  async getGateway(name: string) {
    const config = await this.getConfig();
    return config.gateways?.[name];
  }

  async upsertGateway(name: string, gateway: Record<string, unknown>) {
    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(name)) {
      throw new Error(
        'Tên gateway chỉ được chứa chữ, số, gạch ngang và gạch dưới',
      );
    }

    await this.queueWrite(async () => {
      const config = await this.getConfig();
      config.gateways = config.gateways || {};
      config.gateways[name] = gateway;
      await this.writeConfig(config);
    });
  }

  async setGatewayEnabled(name: string, enabled: boolean) {
    await this.queueWrite(async () => {
      const config = await this.getConfig();
      if (!config.gateways?.[name]) {
        throw new Error('Gateway not found');
      }
      config.gateways[name].enabled = enabled;
      await this.writeConfig(config);
    });
  }

  private async writeConfig(config: Record<string, unknown>) {
    const configPath = this.getConfigFilePath();
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, YAML.stringify(config), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.promises.rename(temporaryPath, configPath);
  }

  private queueWrite(operation: () => Promise<void>) {
    const nextWrite = this.writeQueue.then(operation, operation);
    this.writeQueue = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}
