import { createContext, useContext } from 'react'

export const TransferContext = createContext(null)

export function useTransfers() {
  const transfers = useContext(TransferContext)
  if (!transfers) throw new Error('TransferProvider is required.')
  return transfers
}
