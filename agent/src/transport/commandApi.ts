import { AxiosInstance } from 'axios';
import { PendingCommand } from '../types';

export async function fetchPendingCommands(client: AxiosInstance, deviceId: string): Promise<PendingCommand[]> {
  const res = await client.get<{ commands: PendingCommand[] }>(`/api/v1/commands/pending`, {
    params: { deviceId },
  });
  return res.data.commands || [];
}
