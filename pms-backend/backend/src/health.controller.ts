import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators';
import { DatabaseService } from './database/database.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** Liveness: the process is up. */
  @Public() @Get('live')
  live() { return { status: 'ok' }; }

  /** Readiness: the database answers. */
  @Public() @Get('ready')
  async ready() {
    try {
      await this.db.query('select 1');
      return { status: 'ok', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'down' });
    }
  }
}
