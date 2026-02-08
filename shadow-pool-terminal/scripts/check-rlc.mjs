import { IExec } from 'iexec';
import { Wallet, JsonRpcProvider } from 'ethers';

const RPC_URL = "https://arb-sepolia.g.alchemy.com/v2/lB78AtqzCmwOOeJqlKXYa";
const PRIVATE_KEY = "0x56803719180c7b917cc6fde634712ffa4b6da4260fc2fc55c6107c57de2860cd";

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(PRIVATE_KEY, provider);
const iexec = new IExec({ ethProvider: wallet }, { allowExperimentalNetworks: true });

async function main() {
  const address = await wallet.getAddress();
  console.log("Address:", address);
  
  try {
    const balance = await iexec.wallet.checkBalances(address);
    console.log("Wallet Balances:", balance);
  } catch (e) {
    console.error("Error checking wallet balance:", e);
  }

  try {
    const account = await iexec.account.checkBalance(address);
    console.log("iExec Account Balance:", account);
  } catch (e) {
    console.error("Error checking account balance:", e);
  }
}

main();
