import { Global, Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { PlatformController } from './platform.controller';
import { SequenceService } from './sequence.service';
import { SettingsService } from './settings.service';

@Global()
@Module({ controllers: [PlatformController, ApprovalsController], providers: [SettingsService, SequenceService, ApprovalsService], exports: [SettingsService, SequenceService, ApprovalsService] })
export class PlatformModule {}
