import { address, createKeyPairSignerFromBytes, getBase58Encoder,
    createSolanaRpcSubscriptions, 
    createSolanaRpc,
	sendAndConfirmTransactionFactory,
    lamports,
    pipe,
    createTransactionMessage,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    appendTransactionMessageInstruction,
    getComputeUnitEstimateForTransactionMessageFactory,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    isSolanaError,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    generateKeyPairSigner,
    generateKeyPair,
    signTransactionMessageWithSigners,

} from '@solana/web3.js';

import * as web3 from "@solana/web3.js";
import { getTransferSolInstruction } from '@solana-program/system';

main()

async function main() {

    // The source must always be a Signer, while the destination should be a public address.
    const fromSigner = await generateKeyPairSigner();
    
    const toSigner = await generateKeyPairSigner();
    const toAddress = String(toSigner.address);

    const fromAddress = fromSigner.keyPair.address

    console.log(fromSigner.keyPair.publicKey.); // Output: number

    const rpc_url = "https://devnet.helius-rpc.com/?api-key=cb6958cf-4a5c-45bc-80af-e2f1b4583765";
    const wss_url = "wss://devnet.helius-rpc.com/?api-key=cb6958cf-4a5c-45bc-80af-e2f1b4583765";

    const rpc = createSolanaRpc(rpc_url);
    const rpcSubscriptions = createSolanaRpcSubscriptions(wss_url);

    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions
    });

    /**
     * STEP 1: CREATE THE TRANSFER TRANSACTION
     */
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    
    const instruction = getTransferSolInstruction({
        amount: lamports(1),
        destination: toAddress,
        source: fromSigner
    });
    const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        tx => (
            setTransactionMessageFeePayer(String(fromSigner.keyPair.address), tx)
        ),
        tx => (
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx)
        ),
        tx =>
        appendTransactionMessageInstruction(
            instruction,
            tx,
        ),
    );

    console.log("Transaction message created");

    /**
     * STEP 2: SIGN THE TRANSACTION
     */
    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    console.log("Transaction signed");

    /**
     * STEP 3: GET PRIORITY FEE FROM SIGNED TRANSACTION
     */

    // For improved fees go to link
    //https://www.helius.dev/blog/solana-congestion-how-to-best-send-solana-transactions#advanced-priority-fee-strategies
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const response = await fetch(rpc_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'helius-example',
            method: 'getPriorityFeeEstimate',
            params: [{
                transaction: base64EncodedWireTransaction,
                options: { 
                    transactionEncoding: "base64",
                    recommended: true,
                    }
            }]
        }),
    });
    const { result } = await response.json();
    const priorityFee = result.priorityFeeEstimate;
    console.log("Setting priority fee to ", priorityFee);

    /** 
     * STEP 4: OPTIMIZE COMPUTE UNITS
     */
    const getComputeUnitEstimateForTransactionMessage = getComputeUnitEstimateForTransactionMessageFactory({
        rpc
    });

    // Request an estimate of the actual compute units this message will consume.
    let computeUnitsEstimate = await getComputeUnitEstimateForTransactionMessage(transactionMessage);
    computeUnitsEstimate = (computeUnitsEstimate < 1000) ? 1000 : Math.ceil(computeUnitsEstimate * 1.1);
    console.log("Setting compute units to ", computeUnitsEstimate);

    /**
     * STEP 5: REBUILD AND SIGN FINAL TRANSACTION
     */
        const { value: finalLatestBlockhash } = await rpc.getLatestBlockhash().send();

    const finalTransactionMessage = appendTransactionMessageInstructions(
        [  
            getSetComputeUnitPriceInstruction({ microLamports: priorityFee }), 
            getSetComputeUnitLimitInstruction({ units: computeUnitsEstimate }) 
        ],
        transactionMessage,
    );

    setTransactionMessageLifetimeUsingBlockhash(finalLatestBlockhash, finalTransactionMessage);

    const finalSignedTransaction = await signTransactionMessageWithSigners(finalTransactionMessage);
    console.log("Rebuilt the transaction and signed it");

    /**
     * STEP 6: SEND AND CONFIRM THE FINAL TRANSACTION
     */
    try {
        console.log("Sending and confirming transaction");
        await sendAndConfirmTransaction(finalSignedTransaction, { commitment: 'confirmed', maxRetries: 0, skipPreflight: true});
        console.log('Transfer confirmed: ', getSignatureFromTransaction(finalSignedTransaction));
    } catch (e) {
        if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
            const preflightErrorContext = e.context;
            const preflightErrorMessage = e.message;
            const errorDetailMessage = isSystemError(e.cause, finalTransactionMessage) ?
                getSystemErrorMessage(e.cause.context.code) : e.cause ? e.cause.message : '';
            console.error(preflightErrorContext, '%s: %s', preflightErrorMessage, errorDetailMessage);
        } else {
            throw e;
        }
    }
}
