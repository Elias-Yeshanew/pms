import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { BulkListQuery, BulkPreviewBody, CommitImportDto, GenerateBarcodeDto, ImportQuery, LabelSheetDto } from './bulk.dto';
import { BulkPricesService } from './bulk-prices.service';
import { ImportService } from './import.service';
import { MediaService } from './media.service';

const upload = (max: number) => FileInterceptor('file', { limits: { fileSize: max, files: 1, fields: 5 } });

@ApiTags('Catalog import')
@ApiBearerAuth()
@Controller('products/import')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Get('template') @RequirePermission('products.create') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="products-template.csv"')
  template() { return this.imports.template(); }

  /** Validates every row against the live data and creates nothing. Returns a job to commit once the result looks right. */
  @Post('preview') @HttpCode(200) @RequirePermission('products.create') @ApiConsumes('multipart/form-data') @UseInterceptors(upload(2 * 1024 * 1024))
  preview(@Auth() a: AuthContext, @UploadedFile() file: Express.Multer.File | undefined, @Query() q: ImportQuery) {
    if (!file) throw new BadRequestException('Attach a CSV file in the "file" field.');
    return this.imports.preview(a, file.originalname ?? 'upload.csv', file.buffer.toString('utf8'), q.autoCreate === true);
  }

  @Get(':id') @RequirePermission('products.create') job(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.imports.getJob(a, id); }
  @Post(':id/commit') @HttpCode(200) @RequirePermission('products.create') commit(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: CommitImportDto) { return this.imports.commit(a, id, d); }
}

@ApiTags('Bulk prices')
@ApiBearerAuth()
@Controller('prices/bulk')
export class BulkPricesController {
  constructor(private readonly bulk: BulkPricesService) {}
  @Post('preview') @HttpCode(200) @RequirePermission('prices.change') preview(@Auth() a: AuthContext, @Body() d: BulkPreviewBody) { return this.bulk.preview(a, d); }
  @Get() @RequirePermission('products.read') list(@Query() q: BulkListQuery) { return this.bulk.list(q); }
  @Get(':id') @RequirePermission('products.read') get(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.bulk.get(a, id); }
  @Post(':id/submit') @HttpCode(200) @RequirePermission('prices.change') submit(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.bulk.submit(a, id); }
  @Post(':id/cancel') @HttpCode(200) @RequirePermission('prices.change') cancel(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.bulk.cancel(a, id); }
}

@ApiTags('Product media')
@ApiBearerAuth()
@Controller('products')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post(':id/barcodes/generate') @RequirePermission('products.update') generate(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: GenerateBarcodeDto) { return this.media.generateBarcode(a, id, d.unitId); }

  @Get(':id/barcodes/:barcodeId/label') @RequirePermission('products.read') @Header('Content-Type', 'image/svg+xml; charset=utf-8') @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  label(@Param('id', ParseUUIDPipe) id: string, @Param('barcodeId', ParseUUIDPipe) barcodeId: string) { return this.media.labelSvg(id, barcodeId); }

  @Post('labels/sheet') @HttpCode(200) @RequirePermission('products.read') @Header('Content-Type', 'text/html; charset=utf-8') @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  sheet(@Body() d: LabelSheetDto) { return this.media.labelSheet(d.items, d.columns ?? 3); }

  @Put(':id/image') @RequirePermission('products.update') @ApiConsumes('multipart/form-data') @UseInterceptors(upload(2 * 1024 * 1024))
  uploadImage(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Attach an image in the "file" field.');
    return this.media.saveImage(a, id, file.buffer);
  }

  @Get(':id/image') @RequirePermission('products.read')
  async image(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { data, mime } = await this.media.readImage(id);
    res.set({ 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
    return new StreamableFile(data);
  }

  @Delete(':id/image') @HttpCode(204) @RequirePermission('products.update') async removeImage(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { await this.media.deleteImage(a, id); }
}
