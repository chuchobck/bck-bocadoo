import { Module } from '@nestjs/common';
import { DailyMenuController, DishesController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({ controllers: [DishesController, DailyMenuController], providers: [MenuService], exports: [MenuService] })
export class MenuModule {}
