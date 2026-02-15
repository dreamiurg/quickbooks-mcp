// Handler for account_period_summary tool
// Uses the GeneralLedger report to provide opening/closing balances,
// total debits/credits, and transaction count for any account over a date range.

import QuickBooks from "node-quickbooks";
import { resolveAccount, resolveDepartmentId, promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import { QBReport } from "../../types/index.js";

interface GLRowColData {
  value?: string;
  id?: string;
}

interface GLRow {
  type?: string;
  group?: string;
  ColData?: GLRowColData[];
  Summary?: { ColData?: GLRowColData[] };
  Rows?: { Row?: GLRow[] };
  Header?: { ColData?: GLRowColData[] };
}

interface GLReport {
  Header?: QBReport["Header"];
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> }>;
  };
  Rows?: {
    Row?: GLRow[];
  };
}

interface PeriodSummary {
  openingBalance: number;
  closingBalance: number;
  totalDebits: number;
  totalCredits: number;
  netActivity: number;
  transactionCount: number;
}

/**
 * Parse a GeneralLedger report to extract period summary data.
 * The GL report structure has:
 * - A "Beginning Balance" row (type: "Data", first row typically)
 * - Individual transaction rows with Debit/Credit columns
 * - An "Total" summary row at the end with the ending balance
 */
function parseGLReport(report: GLReport): PeriodSummary {
  const columns = report.Columns?.Column ?? [];

  // Find column indices for Debit, Credit, and Balance
  const debitIdx = columns.findIndex(c => c.ColTitle === "Debit");
  const creditIdx = columns.findIndex(c => c.ColTitle === "Credit");
  const balanceIdx = columns.findIndex(c => c.ColTitle === "Balance");

  let openingBalance = 0;
  let closingBalance = 0;
  let totalDebits = 0;
  let totalCredits = 0;
  let transactionCount = 0;

  const rows = report.Rows?.Row ?? [];

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      // Check for nested sections (grouped by account)
      if (row.Rows?.Row) {
        processRows(row.Rows.Row);
      }

      const colData = row.ColData ?? row.Header?.ColData;
      if (!colData) continue;

      const firstCol = colData[0]?.value ?? "";

      if (firstCol === "Beginning Balance") {
        if (balanceIdx >= 0 && colData[balanceIdx]) {
          openingBalance = parseFloat(colData[balanceIdx].value ?? "0") || 0;
        }
        continue;
      }

      // The summary/total row contains the ending balance
      if (row.Summary?.ColData) {
        const summaryData = row.Summary.ColData;
        if (balanceIdx >= 0 && summaryData[balanceIdx]) {
          closingBalance = parseFloat(summaryData[balanceIdx].value ?? "0") || 0;
        }
        if (debitIdx >= 0 && summaryData[debitIdx]) {
          const val = parseFloat(summaryData[debitIdx].value ?? "0") || 0;
          if (val) totalDebits = val;
        }
        if (creditIdx >= 0 && summaryData[creditIdx]) {
          const val = parseFloat(summaryData[creditIdx].value ?? "0") || 0;
          if (val) totalCredits = val;
        }
        continue;
      }

      // Regular transaction rows
      if (row.type === "Data" && firstCol !== "Beginning Balance") {
        // Count as a transaction if it has a debit or credit value
        const hasDebit = debitIdx >= 0 && colData[debitIdx]?.value && parseFloat(colData[debitIdx].value!) !== 0;
        const hasCredit = creditIdx >= 0 && colData[creditIdx]?.value && parseFloat(colData[creditIdx].value!) !== 0;
        if (hasDebit || hasCredit) {
          transactionCount++;
          // Accumulate debits/credits in case the summary row doesn't have totals
          if (hasDebit) totalDebits += parseFloat(colData[debitIdx].value!) || 0;
          if (hasCredit) totalCredits += parseFloat(colData[creditIdx].value!) || 0;
        }
      }
    }
  }

  processRows(rows);

  // If we found totals from the summary row, we double-counted with line-level accumulation.
  // Re-parse: only use line-level if no summary totals found.
  // Actually, let's re-do this more carefully: reset and parse in two passes.
  // First pass: find summary totals. If found, use those. Otherwise accumulate from lines.
  let summaryDebits: number | null = null;
  let summaryCredits: number | null = null;
  transactionCount = 0;
  openingBalance = 0;
  closingBalance = 0;

  function processRowsFinal(rowList: GLRow[]): void {
    for (const row of rowList) {
      if (row.Rows?.Row) {
        processRowsFinal(row.Rows.Row);
      }

      const colData = row.ColData ?? row.Header?.ColData;

      if (colData) {
        const firstCol = colData[0]?.value ?? "";
        if (firstCol === "Beginning Balance") {
          if (balanceIdx >= 0 && colData[balanceIdx]) {
            openingBalance = parseFloat(colData[balanceIdx].value ?? "0") || 0;
          }
          continue;
        }

        // Count transaction rows
        if (row.type === "Data" && firstCol !== "Beginning Balance") {
          const hasDebit = debitIdx >= 0 && colData[debitIdx]?.value && parseFloat(colData[debitIdx].value!) !== 0;
          const hasCredit = creditIdx >= 0 && colData[creditIdx]?.value && parseFloat(colData[creditIdx].value!) !== 0;
          if (hasDebit || hasCredit) {
            transactionCount++;
          }
        }
      }

      // Summary row has closing balance and totals
      if (row.Summary?.ColData) {
        const summaryData = row.Summary.ColData;
        if (balanceIdx >= 0 && summaryData[balanceIdx]) {
          closingBalance = parseFloat(summaryData[balanceIdx].value ?? "0") || 0;
        }
        if (debitIdx >= 0 && summaryData[debitIdx]) {
          const val = parseFloat(summaryData[debitIdx].value ?? "0") || 0;
          if (val) summaryDebits = val;
        }
        if (creditIdx >= 0 && summaryData[creditIdx]) {
          const val = parseFloat(summaryData[creditIdx].value ?? "0") || 0;
          if (val) summaryCredits = val;
        }
      }
    }
  }

  processRowsFinal(rows);

  // Use summary totals if available
  totalDebits = summaryDebits ?? totalDebits;
  totalCredits = summaryCredits ?? totalCredits;

  const netActivity = totalDebits - totalCredits;

  return {
    openingBalance,
    closingBalance,
    totalDebits,
    totalCredits,
    netActivity,
    transactionCount,
  };
}

export async function handleAccountPeriodSummary(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department, accounting_method } = args;

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Build report options
  const options: Record<string, string> = {
    account: resolvedAccount.Id,
  };

  const today = new Date().toISOString().split("T")[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  options.start_date = startDateResolved;
  options.end_date = endDateResolved;

  if (department) {
    options.department = await resolveDepartmentId(client, department);
  }
  if (accounting_method) {
    options.accounting_method = accounting_method;
  }

  // Call the GeneralLedger report
  const report = (await promisify<unknown>((cb) =>
    client.reportGeneralLedgerDetail(options, cb)
  )) as GLReport;

  // Parse the report
  const summary = parseGLReport(report);

  // Build summary string
  const formatCurrency = (n: number) => {
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const acctLabel = resolvedAccount.AcctNum
    ? `${resolvedAccount.AcctNum} ${resolvedAccount.FullyQualifiedName || resolvedAccount.Name}`
    : resolvedAccount.FullyQualifiedName || resolvedAccount.Name;

  const summaryLines = [
    "Account Period Summary",
    "======================",
    `Account: ${acctLabel} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (department) {
    summaryLines.push(`Department: ${department}`);
  }
  if (accounting_method) {
    summaryLines.push(`Basis: ${accounting_method}`);
  }

  summaryLines.push("");
  summaryLines.push(`Opening Balance:  ${formatCurrency(summary.openingBalance)}`);
  summaryLines.push(`Total Debits:     ${formatCurrency(summary.totalDebits)}`);
  summaryLines.push(`Total Credits:    ${formatCurrency(summary.totalCredits)}`);
  summaryLines.push(`Net Activity:     ${formatCurrency(summary.netActivity)}`);
  summaryLines.push(`Closing Balance:  ${formatCurrency(summary.closingBalance)}`);
  summaryLines.push(`Transactions:     ${summary.transactionCount}`);

  // Build report data
  const reportData = {
    account: {
      id: resolvedAccount.Id,
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved,
    },
    department: department || undefined,
    accountingMethod: accounting_method || "Accrual",
    summary,
    rawReport: report,
  };

  return outputReport("account-period-summary", reportData, summaryLines.join("\n"));
}
