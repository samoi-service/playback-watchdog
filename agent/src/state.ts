import { AgentStatus } from './types';
import { logger } from './logger';

export class AgentState {
  private _status: AgentStatus = 'booting';
  private _lastTransition: Date = new Date();
  private _serverReachable = true;

  get status(): AgentStatus {
    return this._status;
  }

  get lastTransition(): Date {
    return this._lastTransition;
  }

  transition(newStatus: AgentStatus, reason?: string): void {
    if (this._status === newStatus) return;
    const old = this._status;
    this._status = newStatus;
    this._lastTransition = new Date();
    logger.info('state', `${old} -> ${newStatus}`, { reason });
  }

  setServerReachable(reachable: boolean): void {
    if (this._serverReachable === reachable) return;
    this._serverReachable = reachable;
    if (!reachable && this._status !== 'booting') {
      this.transition('offline_buffering', 'server unreachable');
    } else if (reachable && this._status === 'offline_buffering') {
      this.transition('healthy', 'server recovered');
    }
  }

  get isServerReachable(): boolean {
    return this._serverReachable;
  }
}
