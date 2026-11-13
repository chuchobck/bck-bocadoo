import { Module } from '@nestjs/common';
import { OperationsController, OperationsService } from './operations';
import { SummaryController, SummaryService } from './summary';

@Module({ controllers: [SummaryController, OperationsController], providers: [SummaryService, OperationsService] })
export class ReportsModule {}
