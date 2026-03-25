import axios, { AxiosInstance } from 'axios';
import { AgentConfig } from '../types';
import { logger } from '../logger';

export function createApiClient(config: AgentConfig): AxiosInstance {
  const client = axios.create({
    baseURL: config.serverBaseUrl,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': config.deviceId,
      'X-Device-Token': config.deviceToken,
      'X-Protocol-Version': config.protocolVersion,
    },
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error.response?.status;
      const url = error.config?.url;
      logger.warn('api', `Request failed: ${url} -> ${status || error.code}`, {
        url,
        status,
        code: error.code,
      });
      throw error;
    }
  );

  return client;
}
