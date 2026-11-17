import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { AdjustmentsService } from './adjustments.service';
import { CountsService } from './counts.service';
import { TransfersService } from './transfers.service';
import {
  BranchQuery, CreateAdjustmentDto, CreateCountDto, CreateDisposalDto, CreateTransferDto, DispatchDto, EnterCountsDto, ListFilter, ReceiveTransferDto, ResolveDto, ExpiringQuery, FefoQuery, MovementsQuery, ProductQuery, StatusChangeDto, StatusFilter, StockQuery, SweepDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inv: InventoryService, private readonly adj: AdjustmentsService, private readonly transfers: TransfersService, private readonly counts: CountsService) {}

  // ---- reading ----
  @Get('stock') @RequirePermission('inventory.read') stock(@Auth() a: AuthContext, @Query() q: StockQuery) { return this.inv.listStock(a, q); }
  @Get('stock/summary') @RequirePermission('inventory.read') summary(@Auth() a: AuthContext, @Query() q: BranchQuery) { return this.inv.summary(a, q.branchId); }
  @Get('low-stock') @RequirePermission('inventory.read') low(@Auth() a: AuthContext, @Query() q: BranchQuery) { return this.inv.lowStock(a, q.branchId); }
  @Get('expiring') @RequirePermission('inventory.read') expiring(@Auth() a: AuthContext, @Query() q: ExpiringQuery) { return this.inv.expiring(a, q); }
  @Get('valuation') @RequirePermission('inventory.read') valuation(@Auth() a: AuthContext, @Query() q: BranchQuery) { return this.inv.valuation(a, q.branchId); }
  @Get('movements') @RequirePermission('inventory.read') movements(@Auth() a: AuthContext, @Query() q: MovementsQuery) { return this.inv.movements(a, q); }
  @Get('batches') @RequirePermission('inventory.read') batches(@Auth() a: AuthContext, @Query() q: ProductQuery) { return this.inv.listBatches(a, q.productId); }
  @Get('fefo-preview') @RequirePermission('inventory.read') fefo(@Auth() a: AuthContext, @Query() q: FefoQuery) { return this.inv.fefoPreview(a, q); }
  @Get('reconcile') @RequirePermission('inventory.adjust_approve') reconcile(@Auth() a: AuthContext) { return this.inv.reconcile(a); }

  // ---- stock status ----
  @Post('expiry-sweep') @HttpCode(200) @RequirePermission('inventory.adjust') sweep(@Auth() a: AuthContext, @Body() d: SweepDto) { return this.inv.expirySweep(a, d.branchId); }
  @Post('status-changes') @RequirePermission('inventory.read') change(@Auth() a: AuthContext, @Body() d: StatusChangeDto) { return this.inv.changeStatus(a, d); }

  // ---- adjustments ----
  @Get('adjustments') @RequirePermission('inventory.read') listAdj(@Auth() a: AuthContext, @Query() q: StatusFilter) { return this.adj.list(a, q); }
  @Post('adjustments') @RequirePermission('inventory.adjust') createAdj(@Auth() a: AuthContext, @Body() d: CreateAdjustmentDto) { return this.adj.create(a, d); }
  @Get('adjustments/:id') @RequirePermission('inventory.read') getAdj(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.adj.get(a, id); }
  @Post('adjustments/:id/cancel') @HttpCode(200) @RequirePermission('inventory.adjust') cancelAdj(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.adj.cancel(a, id); }

  // ---- disposals ----
  @Get('disposals') @RequirePermission('inventory.read') listDisp(@Auth() a: AuthContext, @Query() q: StatusFilter) { return this.adj.listDisposals(a, q); }
  @Post('disposals') @RequirePermission('inventory.dispose') createDisp(@Auth() a: AuthContext, @Body() d: CreateDisposalDto) { return this.adj.createDisposal(a, d); }
  @Get('disposals/:id') @RequirePermission('inventory.read') getDisp(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.adj.getDisposal(a, id); }
  @Post('disposals/:id/cancel') @HttpCode(200) @RequirePermission('inventory.dispose') cancelDisp(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.adj.cancelDisposal(a, id); }

  // ---- transfers ----
  @Get('transfers') @RequirePermission('inventory.read') listTransfers(@Auth() a: AuthContext, @Query() q: ListFilter) { return this.transfers.list(a, q); }
  @Post('transfers') @RequirePermission('inventory.transfer') createTransfer(@Auth() a: AuthContext, @Body() d: CreateTransferDto) { return this.transfers.create(a, d); }
  @Get('transfers/:id') @RequirePermission('inventory.read') getTransfer(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.transfers.get(a, id); }
  @Post('transfers/:id/dispatch') @HttpCode(200) @RequirePermission('inventory.transfer') dispatch(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: DispatchDto) { return this.transfers.dispatch(a, id, d); }
  @Post('transfers/:id/receive') @HttpCode(200) @RequirePermission('inventory.transfer') receive(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: ReceiveTransferDto) { return this.transfers.receive(a, id, d); }
  @Post('transfers/:id/resolve') @HttpCode(200) @RequirePermission('inventory.transfer_approve') resolve(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: ResolveDto) { return this.transfers.resolve(a, id, d.note); }
  @Post('transfers/:id/cancel') @HttpCode(200) @RequirePermission('inventory.transfer') cancelTransfer(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.transfers.cancel(a, id); }

  // ---- physical counts ----
  @Get('counts') @RequirePermission('inventory.read') listCounts(@Auth() a: AuthContext, @Query() q: ListFilter) { return this.counts.list(a, q); }
  @Post('counts') @RequirePermission('inventory.count') createCount(@Auth() a: AuthContext, @Body() d: CreateCountDto) { return this.counts.create(a, d); }
  @Get('counts/:id') @RequirePermission('inventory.read') getCount(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.counts.get(a, id); }
  @Put('counts/:id/items') @RequirePermission('inventory.count') enterCounts(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() d: EnterCountsDto) { return this.counts.enterCounts(a, id, d.items); }
  @Post('counts/:id/submit') @HttpCode(200) @RequirePermission('inventory.count') submitCount(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.counts.submit(a, id); }
  @Post('counts/:id/cancel') @HttpCode(200) @RequirePermission('inventory.count') cancelCount(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.counts.cancel(a, id); }
}
