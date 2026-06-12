import { VCBBankService } from './vcbbank.services';
import { GateConfig, GateType } from '../../gate.interface';
import { axios } from '../../../shards/helpers/axios';

jest.mock('../../../shards/helpers/axios', () => ({
  axios: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

describe('VCBBankService', () => {
  const config: GateConfig = {
    name: 'vcb_test',
    type: GateType.VCBBANK,
    password: 'test-password',
    account: '123456789',
    login_id: 'test-user',
    device_id: 'test-device',
    user_agent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.56 Safari/537.36',
    repeat_interval_in_sec: 10,
    get_transaction_day_limit: 14,
    get_transaction_count_limit: 100,
  };

  const createService = () =>
    new VCBBankService(
      config,
      { emit: jest.fn() } as any,
      { solveCaptcha: jest.fn().mockResolvedValue('ABCDE') } as any,
      {
        getProxy: jest.fn().mockResolvedValue(null),
        getProxyAgent: jest.fn().mockResolvedValue(undefined),
      } as any,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({
      data: Buffer.from('captcha'),
    });
  });

  it('stops when VCB reports an unverified browser', async () => {
    const service = createService();
    jest.spyOn(service as any, 'makeRequest').mockResolvedValue({
      code: '20231',
      des: 'trình duyệt chưa xác thực',
    });

    await expect((service as any).login()).rejects.toThrow(
      'VCB login failed (20231): trình duyệt chưa xác thực',
    );
  });

  it('stores the authenticated session after a successful login', async () => {
    const service = createService();
    const makeRequest = jest
      .spyOn(service as any, 'makeRequest')
      .mockResolvedValue({
        code: '00',
        des: 'Success',
        sessionId: 'session-id',
        userInfo: {
          cif: 'cif',
          mobileId: 'mobile-id',
          clientId: 'client-id',
        },
      });

    await (service as any).login();

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/utility-service/v2/captcha/MASS/'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': config.user_agent,
        }),
      }),
    );
    expect(makeRequest).toHaveBeenCalledWith(
      '/authen-service/v1/login',
      expect.objectContaining({
        DT: 'WINDOWS_WEB',
        PM: 'Chrome',
        OV: '147.0.7727.56',
      }),
    );
    expect((service as any).sessionId).toBe('session-id');
    expect((service as any).cif).toBe('cif');
    expect((service as any).mobileId).toBe('mobile-id');
    expect((service as any).clientId).toBe('client-id');
  });
});
