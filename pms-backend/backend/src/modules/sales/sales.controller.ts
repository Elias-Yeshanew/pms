import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { CustomersService } from './customers.service';
import { DiscountsService } from './discounts.service';
import { PaymentMethodsService } from './payment-methods.service';
import { PrescriptionsService } from './prescriptions.service';
import { SalesReturnsService } from './sales-returns.service';
import { SalesService } from './sales.service';
import {
  CreateCustomerDto, CreatePaymentMethodDto, CreatePrescriptionDto, CreateReturnBody, CreateSaleBody, CustomerPaymentBody, CustomersQuery, DiscountRequestBody, InspectReturnBody,
  PrescriptionsQuery, RangeBody, ReasonBody, ReceiptQuery, ReturnsQuery, SalesQuery, SummaryQuery, UpdateCustomerDto, UpdatePaymentMethodDto,
} from './sales.dto';

const id = () => Param('id', ParseUUIDPipe);

@ApiTags('Sales')
@ApiBearerAuth()
@Controller()
export class SalesController {
  constructor(
    private readonly sales: SalesService, private readonly returns: SalesReturnsService, private readonly customers: CustomersService,
    private readonly prescriptions: PrescriptionsService, private readonly discounts: DiscountsService, private readonly methods: PaymentMethodsService,
  ) {}

  // ---- payment methods ----
  @Get('payment-methods') @RequirePermission('sales.read') listMethods() { return this.methods.list(); }
  @Post('payment-methods') @RequirePermission('sales.configure') createMethod(@Auth() a: AuthContext, @Body() d: CreatePaymentMethodDto) { return this.methods.create(a, d); }
  @Patch('payment-methods/:id') @RequirePermission('sales.configure') updateMethod(@Auth() a: AuthContext, @id() i: string, @Body() d: UpdatePaymentMethodDto) { return this.methods.update(a, i, d); }

  // ---- sales ----
  /** 201 for a new sale; 200 with the original sale when the same idempotencyKey and body were already processed. */
  @Post('sales') @RequirePermission('sales.create')
  async create(@Auth() a: AuthContext, @Body() d: CreateSaleBody, @Res({ passthrough: true }) res: Response) {
    const r = await this.sales.create(a, d);
    res.status(r.replay ? 200 : 201);
    return r.sale;
  }
  @Get('sales') @RequirePermission('sales.read') list(@Auth() a: AuthContext, @Query() q: SalesQuery) { return this.sales.list(a, q); }
  @Get('sales/summary') @RequirePermission('sales.read') summary(@Auth() a: AuthContext, @Query() q: SummaryQuery) { return this.sales.summary(a, q); }
  @Get('sales/:id') @RequirePermission('sales.read') get(@Auth() a: AuthContext, @id() i: string) { return this.sales.get(a, i); }
  @Get('sales/:id/receipt') @RequirePermission('sales.read') receipt(@Auth() a: AuthContext, @id() i: string, @Query() q: ReceiptQuery) { return this.sales.receipt(a, i, q.reprint === true); }
  @Post('sales/:id/cancel') @HttpCode(200) @RequirePermission('sales.cancel') cancel(@Auth() a: AuthContext, @id() i: string, @Body() d: ReasonBody) { return this.sales.requestCancel(a, i, d.reason); }

  // ---- discount approvals ----
  @Post('discount-requests') @RequirePermission('sales.discount_request') requestDiscount(@Auth() a: AuthContext, @Body() d: DiscountRequestBody) { return this.discounts.request(a, d); }
  @Get('discount-requests/:id') @RequirePermission('sales.read') getDiscount(@Auth() a: AuthContext, @id() i: string) { return this.discounts.get(a, i); }
  @Post('discount-requests/:id/cancel') @HttpCode(200) @RequirePermission('sales.discount_request') cancelDiscount(@Auth() a: AuthContext, @id() i: string) { return this.discounts.cancel(a, i); }

  // ---- returns ----
  @Get('sales-returns') @RequirePermission('sales.read') listReturns(@Auth() a: AuthContext, @Query() q: ReturnsQuery) { return this.returns.list(a, q); }
  @Post('sales-returns') @RequirePermission('sales.return') createReturn(@Auth() a: AuthContext, @Body() d: CreateReturnBody) { return this.returns.create(a, d); }
  @Get('sales-returns/:id') @RequirePermission('sales.read') getReturn(@Auth() a: AuthContext, @id() i: string) { return this.returns.get(a, i); }
  @Post('sales-returns/:id/inspect') @HttpCode(200) @RequirePermission('sales.return_inspect') inspectReturn(@Auth() a: AuthContext, @id() i: string, @Body() d: InspectReturnBody) { return this.returns.inspect(a, i, d); }
  @Post('sales-returns/:id/cancel') @HttpCode(200) @RequirePermission('sales.return') cancelReturn(@Auth() a: AuthContext, @id() i: string) { return this.returns.cancel(a, i); }

  // ---- customers ----
  @Get('customers') @RequirePermission('customers.read') listCustomers(@Query() q: CustomersQuery) { return this.customers.list(q); }
  @Post('customers') @RequirePermission('customers.manage') createCustomer(@Auth() a: AuthContext, @Body() d: CreateCustomerDto) { return this.customers.create(a, d); }
  @Get('customers/reconcile') @RequirePermission('customers.payment_reverse') reconcileCustomers() { return this.customers.reconcile(); }
  @Get('customers/:id') @RequirePermission('customers.read') getCustomer(@Auth() a: AuthContext, @id() i: string) { return this.customers.get(a, i); }
  @Patch('customers/:id') @RequirePermission('customers.manage') updateCustomer(@Auth() a: AuthContext, @id() i: string, @Body() d: UpdateCustomerDto) { return this.customers.update(a, i, d); }
  @Get('customers/:id/statement') @RequirePermission('customers.read') statement(@Auth() a: AuthContext, @id() i: string, @Query() q: RangeBody) { return this.customers.statement(a, i, q.from, q.to); }
  @Get('customers/:id/payments') @RequirePermission('customers.read') customerPayments(@Auth() a: AuthContext, @id() i: string) { return this.customers.listPayments(a, i); }
  @Post('customers/:id/payments') @RequirePermission('customers.payment') receivePayment(@Auth() a: AuthContext, @id() i: string, @Body() d: CustomerPaymentBody) { return this.customers.receivePayment(a, i, d); }
  @Post('customer-payments/:id/reverse') @HttpCode(200) @RequirePermission('customers.payment_reverse') reversePayment(@Auth() a: AuthContext, @id() i: string, @Body() d: ReasonBody) { return this.customers.reversePayment(a, i, d.reason); }

  // ---- prescriptions ----
  @Get('prescriptions') @RequirePermission('prescriptions.read') listRx(@Auth() a: AuthContext, @Query() q: PrescriptionsQuery) { return this.prescriptions.list(a, q); }
  @Post('prescriptions') @RequirePermission('prescriptions.manage') createRx(@Auth() a: AuthContext, @Body() d: CreatePrescriptionDto) { return this.prescriptions.create(a, d as never); }
  @Get('prescriptions/:id') @RequirePermission('prescriptions.read') getRx(@Auth() a: AuthContext, @id() i: string) { return this.prescriptions.get(a, i); }
  @Post('prescriptions/:id/validate') @HttpCode(200) @RequirePermission('prescriptions.validate') validateRx(@Auth() a: AuthContext, @id() i: string) { return this.prescriptions.validate(a, i); }
  @Post('prescriptions/:id/reject') @HttpCode(200) @RequirePermission('prescriptions.validate') rejectRx(@Auth() a: AuthContext, @id() i: string, @Body() d: ReasonBody) { return this.prescriptions.reject(a, i, d.reason); }
  @Post('prescriptions/:id/cancel') @HttpCode(200) @RequirePermission('prescriptions.manage') cancelRx(@Auth() a: AuthContext, @id() i: string) { return this.prescriptions.cancel(a, i); }

  @Put('prescriptions/:id/attachment') @RequirePermission('prescriptions.manage') @ApiConsumes('multipart/form-data') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3 } }))
  uploadRx(@Auth() a: AuthContext, @id() i: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Attach a file in the "file" field.');
    return this.prescriptions.saveAttachment(a, i, file.buffer);
  }
  @Get('prescriptions/:id/attachment') @RequirePermission('prescriptions.read')
  async downloadRx(@Auth() a: AuthContext, @id() i: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.prescriptions.readAttachment(a, i);
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${f.name}"` });
    return new StreamableFile(f.data);
  }
}
export { Header };
