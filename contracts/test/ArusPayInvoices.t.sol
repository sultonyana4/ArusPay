// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/ArusPayInvoices.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes4 revertData) external;
}

contract ArusPayInvoicesTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ArusPayInvoices private invoices;
    address private constant MERCHANT = address(0xA11CE);
    address private constant OTHER_MERCHANT = address(0xCAFE);
    address private constant ATTACKER = address(0xBAD);
    address private constant PAYER = address(0xB0B);
    bytes32 private constant INVOICE_ID = keccak256("aruspay-invoice-001");
    uint256 private constant AMOUNT = 12_500_000_000_000_000_000; // 12.5 native USDC

    function setUp() public {
        invoices = new ArusPayInvoices();
        vm.deal(PAYER, 100 ether);
    }

    function testCreateAndPayInvoiceForwardsExactAmount() public {
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        uint256 merchantBalanceBefore = MERCHANT.balance;
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT}(MERCHANT, INVOICE_ID);

        require(MERCHANT.balance == merchantBalanceBefore + AMOUNT, "merchant did not receive exact amount");
        ArusPayInvoices.Invoice memory invoice = invoices.getInvoice(MERCHANT, INVOICE_ID);
        require(invoice.merchant == MERCHANT, "wrong merchant");
        require(invoice.amount == AMOUNT, "wrong amount");
        require(invoice.status == ArusPayInvoices.InvoiceStatus.Paid, "invoice not marked paid");
    }

    function testWrongAmountReverts() public {
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        vm.expectRevert(ArusPayInvoices.WrongAmount.selector);
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT - 1}(MERCHANT, INVOICE_ID);
    }

    function testExpiredInvoiceCannotBePaid() public {
        uint64 expiry = uint64(block.timestamp + 100);
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, expiry);
        vm.warp(expiry);

        vm.expectRevert(ArusPayInvoices.InvoiceExpired.selector);
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT}(MERCHANT, INVOICE_ID);
    }

    function testOnlyMerchantCanCancelInvoice() public {
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        vm.expectRevert(ArusPayInvoices.NotMerchant.selector);
        vm.prank(PAYER);
        invoices.cancelInvoice(MERCHANT, INVOICE_ID);

        vm.prank(MERCHANT);
        invoices.cancelInvoice(MERCHANT, INVOICE_ID);
        ArusPayInvoices.Invoice memory invoice = invoices.getInvoice(MERCHANT, INVOICE_ID);
        require(invoice.status == ArusPayInvoices.InvoiceStatus.Cancelled, "invoice not cancelled");
    }

    function testMerchantTransferFailureRevertsAndLeavesInvoiceOpen() public {
        bytes32 rejectingId = keccak256("non-payable-test-merchant-invoice");
        invoices.createInvoice(rejectingId, AMOUNT, 0);

        // This test contract is the merchant and has no payable receiver.
        vm.expectRevert(ArusPayInvoices.MerchantTransferFailed.selector);
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT}(address(this), rejectingId);

        ArusPayInvoices.Invoice memory invoice = invoices.getInvoice(address(this), rejectingId);
        require(invoice.status == ArusPayInvoices.InvoiceStatus.Open, "failed payment changed invoice status");
    }

    function testDuplicateInvoiceIdRevertsWithinMerchantNamespace() public {
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        vm.expectRevert(ArusPayInvoices.InvoiceAlreadyExists.selector);
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);
    }

    function testAnotherAddressCannotReserveMerchantsInvoiceId() public {
        vm.prank(ATTACKER);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        // The attacker may use the same ID in their own namespace, but cannot occupy MERCHANT's.
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        ArusPayInvoices.Invoice memory attackerInvoice = invoices.getInvoice(ATTACKER, INVOICE_ID);
        ArusPayInvoices.Invoice memory merchantInvoice = invoices.getInvoice(MERCHANT, INVOICE_ID);
        require(attackerInvoice.merchant == ATTACKER, "attacker namespace corrupted");
        require(merchantInvoice.merchant == MERCHANT, "merchant could not create invoice");
        require(merchantInvoice.status == ArusPayInvoices.InvoiceStatus.Open, "merchant invoice not open");
    }

    function testSameInvoiceIdCanBePaidIndependentlyForDifferentMerchants() public {
        vm.prank(MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);
        vm.prank(OTHER_MERCHANT);
        invoices.createInvoice(INVOICE_ID, AMOUNT, 0);

        uint256 firstBalanceBefore = MERCHANT.balance;
        uint256 secondBalanceBefore = OTHER_MERCHANT.balance;
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT}(MERCHANT, INVOICE_ID);
        vm.prank(PAYER);
        invoices.payInvoice{value: AMOUNT}(OTHER_MERCHANT, INVOICE_ID);

        require(MERCHANT.balance == firstBalanceBefore + AMOUNT, "first merchant paid incorrectly");
        require(OTHER_MERCHANT.balance == secondBalanceBefore + AMOUNT, "second merchant paid incorrectly");
        require(
            invoices.getInvoice(MERCHANT, INVOICE_ID).status == ArusPayInvoices.InvoiceStatus.Paid,
            "first invoice not paid"
        );
        require(
            invoices.getInvoice(OTHER_MERCHANT, INVOICE_ID).status == ArusPayInvoices.InvoiceStatus.Paid,
            "second invoice not paid"
        );
    }
}
