import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { AnalyticsService } from './analytics.service';
import { OrdersService } from './orders.service';
import { PayablesService } from './payables.service';
import {
  AgingQuery, ApplyCreditDto, BranchFilter, CreateInvoiceDto, CreateOrderDto, CreatePaymentDto, CreateRequestDto, CreateReturnDto, CreditsQuery, InspectDto, InvoicesQuery, ListQuery, OrdersQuery,
  ProductFilter, RangeQuery, ProcurementReasonDto, ReceiveGoodsDto, ReviseOrderDto, UpdateOrderDto,
} from './procurement.dto';
import { ReceivingService } from './receiving.service';
import { RequestsService } from './requests.service';
import { ReturnsService } from './returns.service';

const id = () => Param('id', ParseUUIDPipe);

@ApiTags('Procurement')
@ApiBearerAuth()
@Controller()
export class ProcurementController {
  constructor(
    private readonly requests: RequestsService, private readonly orders: OrdersService, private readonly receiving: ReceivingService,
    private readonly payables: PayablesService, private readonly returns: ReturnsService, private readonly analytics: AnalyticsService,
  ) {}

  // ---- reorder, requests ----
  @Get('procurement/reorder-suggestions') @RequirePermission('procurement.read', 'inventory.read') suggestions(@Auth() a: AuthContext, @Query() q: BranchFilter) { return this.requests.reorderSuggestions(a, q.branchId); }
  @Get('purchase-requests') @RequirePermission('procurement.read') listRequests(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.requests.list(a, q); }
  @Post('purchase-requests') @RequirePermission('procurement.request') createRequest(@Auth() a: AuthContext, @Body() d: CreateRequestDto) { return this.requests.create(a, d); }
  @Get('purchase-requests/:id') @RequirePermission('procurement.read') getRequest(@Auth() a: AuthContext, @id() i: string) { return this.requests.get(a, i); }
  @Post('purchase-requests/:id/cancel') @HttpCode(200) @RequirePermission('procurement.request') cancelRequest(@Auth() a: AuthContext, @id() i: string) { return this.requests.cancel(a, i); }

  // ---- purchase orders ----
  @Get('purchase-orders') @RequirePermission('procurement.read') listOrders(@Auth() a: AuthContext, @Query() q: OrdersQuery) { return this.orders.list(a, q); }
  @Post('purchase-orders') @RequirePermission('procurement.order') createOrder(@Auth() a: AuthContext, @Body() d: CreateOrderDto) { return this.orders.create(a, d); }
  @Get('purchase-orders/:id') @RequirePermission('procurement.read') getOrder(@Auth() a: AuthContext, @id() i: string) { return this.orders.get(a, i); }
  @Patch('purchase-orders/:id') @RequirePermission('procurement.order') updateOrder(@Auth() a: AuthContext, @id() i: string, @Body() d: UpdateOrderDto) { return this.orders.updateDraft(a, i, d); }
  @Post('purchase-orders/:id/submit') @HttpCode(200) @RequirePermission('procurement.order') submitOrder(@Auth() a: AuthContext, @id() i: string) { return this.orders.submit(a, i); }
  @Post('purchase-orders/:id/revise') @HttpCode(200) @RequirePermission('procurement.order') reviseOrder(@Auth() a: AuthContext, @id() i: string, @Body() d: ReviseOrderDto) { return this.orders.revise(a, i, d); }
  @Post('purchase-orders/:id/cancel') @HttpCode(200) @RequirePermission('procurement.order') cancelOrder(@Auth() a: AuthContext, @id() i: string, @Body() d: ProcurementReasonDto) { return this.orders.cancel(a, i, d.reason); }
  @Post('purchase-orders/:id/close') @HttpCode(200) @RequirePermission('procurement.order') closeOrder(@Auth() a: AuthContext, @id() i: string, @Body() d: ProcurementReasonDto) { return this.orders.close(a, i, d.reason); }
  @Get('purchase-orders/:id/matching') @RequirePermission('procurement.read') matching(@Auth() a: AuthContext, @id() i: string) { return this.orders.matching(a, i); }

  // ---- receiving ----
  @Get('goods-receipts') @RequirePermission('procurement.read') listReceipts(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.receiving.list(a, q); }
  @Post('goods-receipts') @RequirePermission('procurement.receive') receive(@Auth() a: AuthContext, @Body() d: ReceiveGoodsDto) { return this.receiving.receive(a, d); }
  @Get('goods-receipts/:id') @RequirePermission('procurement.read') getReceipt(@Auth() a: AuthContext, @id() i: string) { return this.receiving.get(a, i); }
  @Post('goods-receipts/:id/inspect') @HttpCode(200) @RequirePermission('procurement.inspect') inspect(@Auth() a: AuthContext, @id() i: string, @Body() d: InspectDto) { return this.receiving.inspect(a, i, d); }

  // ---- invoices, payments, credits ----
  @Get('supplier-invoices') @RequirePermission('procurement.read') listInvoices(@Auth() a: AuthContext, @Query() q: InvoicesQuery) { return this.payables.listInvoices(a, q); }
  @Post('supplier-invoices') @RequirePermission('procurement.invoice') createInvoice(@Auth() a: AuthContext, @Body() d: CreateInvoiceDto) { return this.payables.createInvoice(a, d); }
  @Get('supplier-invoices/:id') @RequirePermission('procurement.read') getInvoice(@Auth() a: AuthContext, @id() i: string) { return this.payables.getInvoice(a, i); }
  @Post('supplier-invoices/:id/cancel') @HttpCode(200) @RequirePermission('procurement.invoice') cancelInvoice(@Auth() a: AuthContext, @id() i: string) { return this.payables.cancelInvoice(a, i); }

  @Get('supplier-payments') @RequirePermission('procurement.read') listPayments(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.payables.listPayments(a, q); }
  @Post('supplier-payments') @RequirePermission('procurement.pay') pay(@Auth() a: AuthContext, @Body() d: CreatePaymentDto) { return this.payables.recordPayment(a, d); }
  @Get('supplier-payments/:id') @RequirePermission('procurement.read') getPayment(@Auth() a: AuthContext, @id() i: string) { return this.payables.getPayment(a, i); }
  @Post('supplier-payments/:id/reverse') @HttpCode(200) @RequirePermission('procurement.payment_reverse') reverse(@Auth() a: AuthContext, @id() i: string, @Body() d: ProcurementReasonDto) { return this.payables.reversePayment(a, i, d.reason); }

  @Get('supplier-credits') @RequirePermission('procurement.read') credits(@Auth() a: AuthContext, @Query() q: CreditsQuery) { return this.payables.listCredits(a, q.supplierId); }
  @Post('supplier-credits/:id/apply') @HttpCode(200) @RequirePermission('procurement.pay') applyCredit(@Auth() a: AuthContext, @id() i: string, @Body() d: ApplyCreditDto) { return this.payables.applyCredit(a, i, d); }

  // ---- returns ----
  @Get('purchase-returns') @RequirePermission('procurement.read') listReturns(@Auth() a: AuthContext, @Query() q: ListQuery) { return this.returns.list(a, q); }
  @Post('purchase-returns') @RequirePermission('procurement.return') createReturn(@Auth() a: AuthContext, @Body() d: CreateReturnDto) { return this.returns.create(a, d); }
  @Get('purchase-returns/:id') @RequirePermission('procurement.read') getReturn(@Auth() a: AuthContext, @id() i: string) { return this.returns.get(a, i); }
  @Post('purchase-returns/:id/cancel') @HttpCode(200) @RequirePermission('procurement.return') cancelReturn(@Auth() a: AuthContext, @id() i: string) { return this.returns.cancel(a, i); }

  // ---- supplier balances and analysis ----
  @Get('suppliers/:id/balance') @RequirePermission('procurement.read') balance(@Auth() a: AuthContext, @id() i: string) { return this.payables.balance(a, i); }
  @Get('suppliers/:id/statement') @RequirePermission('procurement.read') statement(@Auth() a: AuthContext, @id() i: string, @Query() q: RangeQuery) { return this.payables.statement(a, i, q.from, q.to); }
  @Get('suppliers/:id/performance') @RequirePermission('procurement.read') performance(@Auth() a: AuthContext, @id() i: string, @Query() q: RangeQuery) { return this.analytics.supplierPerformance(a, i, q.from, q.to); }
  @Get('procurement/payables-aging') @RequirePermission('procurement.read') aging(@Auth() a: AuthContext, @Query() q: AgingQuery) { return this.payables.aging(a, q); }
  @Get('procurement/price-comparison') @RequirePermission('procurement.read') priceComparison(@Query() q: ProductFilter) { return this.analytics.priceComparison(q.productId); }
}
