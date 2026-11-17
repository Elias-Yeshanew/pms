import { Module } from '@nestjs/common';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesService } from './facilities.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

@Module({ controllers: [OrgController, FacilitiesController], providers: [OrgService, FacilitiesService], exports: [OrgService] })
export class OrgModule {}
