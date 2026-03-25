import { AxiosInstance } from 'axios';
import { HeartbeatPayload } from '../types';

export async function sendHeartbeat(client: AxiosInstance, payload: HeartbeatPayload): Promise<void> {
  await client.post('/api/v1/heartbeat', payload);
}
