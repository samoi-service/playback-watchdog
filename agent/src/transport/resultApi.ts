import { AxiosInstance } from 'axios';
import { CommandResult } from '../types';

export async function reportCommandResult(client: AxiosInstance, deviceId: string, result: CommandResult): Promise<void> {
  await client.post('/api/v1/command-result', {
    deviceId,
    ...result,
    reportedAt: new Date().toISOString(),
  });
}
