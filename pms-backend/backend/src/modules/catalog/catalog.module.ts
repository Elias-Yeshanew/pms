import { Module } from '@nestjs/common';
import { BulkPricesService } from './bulk-prices.service';
import { BulkPricesController, ImportController, MediaController } from './bulk.controller';
import { CatalogController } from './catalog.controller';
import { ImportService } from './import.service';
import { MediaService } from './media.service';
import { ProductsService } from './products.service';
import { ReferenceService } from './reference.service';

// The import/media controllers come first so their fixed paths (products/import/..., products/labels/...) win over products/:id
@Module({
  controllers: [ImportController, BulkPricesController, MediaController, CatalogController],
  providers: [ReferenceService, ProductsService, ImportService, BulkPricesService, MediaService],
  exports: [ProductsService],
})
export class CatalogModule {}
