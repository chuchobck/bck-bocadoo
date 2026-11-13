import { Module } from '@nestjs/common';
import { SummaryController, SummaryService } from './summary';

@Module({ controllers: [SummaryController], providers: [SummaryService] })
export class ReportsModule {}
