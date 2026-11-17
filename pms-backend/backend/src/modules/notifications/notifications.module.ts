import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService, JobsService], exports: [NotificationsService, JobsService] })
export class NotificationsModule {}
