import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { ReferenceService } from './reference.service';
import { ProductsService } from './products.service';
import {
  BarcodeDto, ChangePriceDto, ConvertDto, CreateProductCategoryDto, CreateDosageFormDto, CreateManufacturerDto, CreateProductDto, CreateUnitDto,
  ProductsQuery, SetUnitsDto, UpdateProductCategoryDto, UpdateManufacturerDto, UpdateProductDto, UpdateUnitDto, VersionBody,
} from './products.dto';

@ApiTags('Catalog')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(private readonly ref: ReferenceService, private readonly products: ProductsService) {}

  // ---- reference data ----
  @Get('units') @RequirePermission('products.read') units() { return this.ref.listUnits(); }
  @Post('units') @RequirePermission('catalog.manage') createUnit(@Auth() a: AuthContext, @Body() d: CreateUnitDto) { return this.ref.createUnit(a, d); }
  @Patch('units/:id') @RequirePermission('catalog.manage') updateUnit(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateUnitDto) { return this.ref.updateUnit(a, id, d); }

  @Get('dosage-forms') @RequirePermission('products.read') forms() { return this.ref.listDosageForms(); }
  @Post('dosage-forms') @RequirePermission('catalog.manage') createForm(@Auth() a: AuthContext, @Body() d: CreateDosageFormDto) { return this.ref.createDosageForm(a, d); }

  @Get('categories') @RequirePermission('products.read') categories() { return this.ref.listCategories(); }
  @Post('categories') @RequirePermission('catalog.manage') createCategory(@Auth() a: AuthContext, @Body() d: CreateProductCategoryDto) { return this.ref.createCategory(a, d); }
  @Patch('categories/:id') @RequirePermission('catalog.manage') updateCategory(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateProductCategoryDto) { return this.ref.updateCategory(a, id, d); }

  @Get('manufacturers') @RequirePermission('products.read') manufacturers() { return this.ref.listManufacturers(); }
  @Post('manufacturers') @RequirePermission('catalog.manage') createManufacturer(@Auth() a: AuthContext, @Body() d: CreateManufacturerDto) { return this.ref.createManufacturer(a, d); }
  @Patch('manufacturers/:id') @RequirePermission('catalog.manage') updateManufacturer(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateManufacturerDto) { return this.ref.updateManufacturer(a, id, d); }

  // ---- products ----
  @Get('products') @RequirePermission('products.read') list(@Query() q: ProductsQuery) { return this.products.list(q); }
  @Post('products') @RequirePermission('products.create') create(@Auth() a: AuthContext, @Body() d: CreateProductDto) { return this.products.create(a, d); }
  @Get('products/by-barcode/:barcode') @RequirePermission('products.read') byBarcode(@Param('barcode') barcode: string) { return this.products.byBarcode(barcode); }
  @Get('products/:id') @RequirePermission('products.read') get(@Param('id', ParseUUIDPipe) id: string) { return this.products.get(id); }
  @Patch('products/:id') @RequirePermission('products.update') update(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateProductDto) { return this.products.update(a, id, d); }
  @Post('products/:id/deactivate') @HttpCode(200) @RequirePermission('products.update') deactivate(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: VersionBody) { return this.products.setActive(a, id, false, d.version); }
  @Post('products/:id/activate') @HttpCode(200) @RequirePermission('products.update') activate(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: VersionBody) { return this.products.setActive(a, id, true, d.version); }
  @Put('products/:id/units') @RequirePermission('products.update') setUnits(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: SetUnitsDto) { return this.products.setUnits(a, id, d.units); }
  @Post('products/:id/barcodes') @RequirePermission('products.update') addBarcode(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: BarcodeDto) { return this.products.addBarcode(a, id, d); }
  @Delete('products/:id/barcodes/:barcodeId') @RequirePermission('products.update') removeBarcode(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('barcodeId', ParseUUIDPipe) bid: string) { return this.products.removeBarcode(a, id, bid); }
  @Post('products/:id/prices') @RequirePermission('prices.change') changePrice(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: ChangePriceDto) { return this.products.changePrice(a, id, d); }
  @Get('products/:id/prices') @RequirePermission('products.read') priceHistory(@Param('id', ParseUUIDPipe) id: string) { return this.products.priceHistory(id); }
  @Post('products/:id/convert') @HttpCode(200) @RequirePermission('products.read') convert(@Param('id', ParseUUIDPipe) id: string, @Body() d: ConvertDto) { return this.products.convert(id, d); }
}
