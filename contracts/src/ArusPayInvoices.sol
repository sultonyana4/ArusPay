// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArusPay Invoices
/// @notice Minimal non-custodial invoice settlement for Arc's native USDC.
/// @dev Amounts are native-value base units (18 decimals), not ERC-20 USDC units (6 decimals).
contract ArusPayInvoices {
    enum InvoiceStatus {
        None,
        Open,
        Paid,
        Cancelled
    }

    struct Invoice {
        address merchant;
        uint256 amount;
        uint64 expiresAt;
        InvoiceStatus status;
    }

    // Invoice IDs are unique per merchant, not globally. Creation always writes
    // into msg.sender's namespace, so another address cannot reserve a merchant's ID.
    mapping(address merchant => mapping(bytes32 invoiceId => Invoice invoice)) public invoices;

    uint256 private _lock = 1;

    error InvalidInvoiceId();
    error InvalidAmount();
    error InvalidExpiry();
    error InvoiceAlreadyExists();
    error InvoiceNotOpen();
    error InvoiceExpired();
    error WrongAmount();
    error NotMerchant();
    error MerchantTransferFailed();
    error ReentrantCall();

    event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 amount, uint64 expiresAt);
    event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount);
    event InvoiceCancelled(bytes32 indexed invoiceId, address indexed merchant);

    modifier nonReentrant() {
        if (_lock != 1) revert ReentrantCall();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Create an invoice for the caller. A zero expiry means no expiry.
    /// @param invoiceId Unique opaque ID within the caller's merchant namespace.
    /// @param amount Exact native-USDC amount in 18-decimal base units.
    /// @param expiresAt Unix timestamp; zero means the invoice does not expire.
    function createInvoice(bytes32 invoiceId, uint256 amount, uint64 expiresAt) external {
        if (invoiceId == bytes32(0)) revert InvalidInvoiceId();
        if (amount == 0) revert InvalidAmount();
        if (invoices[msg.sender][invoiceId].status != InvoiceStatus.None) {
            revert InvoiceAlreadyExists();
        }
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();

        invoices[msg.sender][invoiceId] =
            Invoice({merchant: msg.sender, amount: amount, expiresAt: expiresAt, status: InvoiceStatus.Open});

        emit InvoiceCreated(invoiceId, msg.sender, amount, expiresAt);
    }

    /// @notice Pay an open invoice and forward native USDC directly to its merchant.
    /// @dev The transaction is atomic: a failed merchant transfer leaves the invoice unpaid.
    /// @param merchant The merchant namespace containing invoiceId.
    /// @param invoiceId The merchant-scoped invoice ID.
    function payInvoice(address merchant, bytes32 invoiceId) external payable nonReentrant {
        Invoice storage invoice = invoices[merchant][invoiceId];
        if (invoice.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (invoice.expiresAt != 0 && block.timestamp >= invoice.expiresAt) revert InvoiceExpired();
        if (msg.value != invoice.amount) revert WrongAmount();

        // Effects before interaction. If forwarding fails, the entire transaction reverts.
        invoice.status = InvoiceStatus.Paid;
        (bool success,) = payable(invoice.merchant).call{value: msg.value}("");
        if (!success) revert MerchantTransferFailed();

        emit InvoicePaid(invoiceId, invoice.merchant, msg.sender, msg.value);
    }

    /// @notice Cancel an unpaid invoice. Only its merchant may cancel it.
    /// @param merchant The merchant namespace containing invoiceId.
    /// @param invoiceId The merchant-scoped invoice ID.
    function cancelInvoice(address merchant, bytes32 invoiceId) external {
        Invoice storage invoice = invoices[merchant][invoiceId];
        if (invoice.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (invoice.merchant != msg.sender) revert NotMerchant();

        invoice.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId, merchant);
    }

    /// @notice Return an invoice record using its merchant and merchant-scoped ID.
    function getInvoice(address merchant, bytes32 invoiceId) external view returns (Invoice memory) {
        return invoices[merchant][invoiceId];
    }
}
