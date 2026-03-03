import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'

// Define types for strict TypeScript
interface LeadData {
    id: string
    client_name: string
    policy_type: string
    renewal_date: string | null
    created_at: string
    carrier: string | null
    total_premium: number | null
    policy_number: string | null
    policy_flow: string | null
    insurence_category: string | null
    assigned_csr: string | null
    assigned_csr_profile?: {
        full_name: string | null
    } | {
        full_name: string | null
    }[] | null
}

export async function POST(request: Request) {
    // In Next.js 15/16 (detected in package.json), cookies() is asynchronous.
    // The error "Property 'get' does not exist on type 'Promise<ReadonlyRequestCookies>'"
    // confirms that cookies() returns a Promise and must be awaited.
    const cookieStore = await cookies()

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        )
                    } catch {
                        // The `setAll` method was called from a Server Component.
                    }
                },
            },
        }
    )

    // 1. Auth Check
    const {
        data: { user },
        error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
        month,
        policy_type,
        insurence_category,
        customer_name,
        assigned_csr,
        policy_flow,
        exportType // 'json', 'excel', 'pdf'
    } = body

    // 2. RBAC: Get User Role
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role, manager_id')
        .eq('id', user.id)
        .single()

    if (profileError || !profile) {
        console.error('Profile not found', profileError)
        return NextResponse.json({ error: 'Profile not found. Contact admin.' }, { status: 403 })
    }

    const role = profile.role

    // 3. Build Query
    let query = supabase
        .from('temp_leads_basics')
        .select(`
      id,
      client_name,
      policy_type,
      renewal_date,
      created_at,
      carrier,
      total_premium,
      policy_number,
      policy_flow,
      insurence_category,
      assigned_csr,
      assigned_csr_profile:profiles!assigned_csr (full_name)
    `)

    // 4. Apply Filters
    if (month) {
        const startDate = `${month}-01`
        const [y, m] = month.split('-')
        const date = new Date(parseInt(y), parseInt(m), 0)
        const endDate = date.toISOString().split('T')[0]
        query = query.gte('renewal_date', startDate).lte('renewal_date', endDate)
    }

    if (policy_type) query = query.eq('policy_type', policy_type)
    if (insurence_category) query = query.eq('insurence_category', insurence_category)
    if (policy_flow) query = query.eq('policy_flow', policy_flow)
    if (customer_name) query = query.ilike('client_name', `%${customer_name}%`)

    // 5. Apply RBAC Filters
    if (role === 'admin') {
        if (assigned_csr) query = query.eq('assigned_csr', assigned_csr)
    } else if (role === 'manager') {
        const { data: team } = await supabase
            .from('profiles')
            .select('id')
            .or(`manager_id.eq.${user.id},id.eq.${user.id}`)

        const teamIds = team?.map(t => t.id) || [user.id]

        if (assigned_csr) {
            if (!teamIds.includes(assigned_csr)) {
                return NextResponse.json({ error: 'Access denied to this CSR data' }, { status: 403 })
            }
            query = query.eq('assigned_csr', assigned_csr)
        } else {
            query = query.in('assigned_csr', teamIds)
        }
    } else {
        if (assigned_csr && assigned_csr !== user.id) {
            return NextResponse.json({ error: 'Access denied' }, { status: 403 })
        }
        query = query.eq('assigned_csr', user.id)
    }

    const { data, error } = await query

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const typedData = data as unknown as LeadData[] | null

    // 6. Handle Export
    if (exportType === 'excel') {
        const workbook = new ExcelJS.Workbook()
        const worksheet = workbook.addWorksheet('Monthly Report')

        worksheet.columns = [
            { header: 'Client Name', key: 'client_name', width: 20 },
            { header: 'Policy Type', key: 'policy_type', width: 20 },
            { header: 'Category', key: 'insurence_category', width: 15 },
            { header: 'Flow', key: 'policy_flow', width: 10 },
            { header: 'Premium', key: 'total_premium', width: 15 },
            { header: 'CSR', key: 'csr', width: 20 },
            { header: 'Date', key: 'date', width: 15 },
        ]

        typedData?.forEach((row) => {
            const csrInfo = row.assigned_csr_profile
            const csrFullName = Array.isArray(csrInfo) 
                ? csrInfo[0]?.full_name 
                : csrInfo?.full_name

            worksheet.addRow({
                client_name: row.client_name,
                policy_type: row.policy_type,
                insurence_category: row.insurence_category,
                policy_flow: row.policy_flow,
                total_premium: row.total_premium,
                csr: csrFullName || row.assigned_csr,
                date: row.renewal_date || (row.created_at ? row.created_at.split('T')[0] : '-')
            })
        })

        const buffer = await workbook.xlsx.writeBuffer()

        return new Response(buffer as any, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="Monthly_Report_${month || 'All'}.xlsx"`
            }
        })
    }


    if (exportType === 'pdf') {
        const { default: PDFDocument } = await import('pdfkit')

        // Create a new PDF document
        const doc = new PDFDocument({ margin: 30, size: 'A4' })

        // Stream appropriate headers
        const headers = new Headers()
        headers.set('Content-Type', 'application/pdf')
        headers.set('Content-Disposition', `attachment; filename="Monthly_Report_${month || 'All'}.pdf"`)

        // Create a TransformStream to pipe the PDF into
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()

        doc.pipe({
            write: (chunk: any) => writer.write(chunk),
            end: () => writer.close(),
            on: () => { },
            once: () => { },
            emit: () => true,
        } as any)

        // --- PDF CONTENT ---

        // Title
        doc.fontSize(20).text(`Monthly Report: ${month || 'All Time'}`, { align: 'center' })
        doc.moveDown()

        // Filter Summary
        doc.fontSize(10).text(`Generated by: ${user.email}`)
        doc.text(`Date: ${new Date().toLocaleDateString()}`)
        doc.moveDown()

        // Table Header
        const tableTop = 150
        const colX = {
            client: 30,
            type: 150,
            premium: 280,
            csr: 380,
            date: 480
        }

        doc.font('Helvetica-Bold')
        doc.text('Client', colX.client, tableTop)
        doc.text('Type', colX.type, tableTop)
        doc.text('Premium', colX.premium, tableTop)
        doc.text('CSR', colX.csr, tableTop)
        doc.text('Date', colX.date, tableTop)

        doc.moveTo(30, tableTop + 15).lineTo(570, tableTop + 15).stroke()

        // Table Rows
        let y = tableTop + 25
        doc.font('Helvetica').fontSize(9)

        let totalPremium = 0

        typedData?.forEach((row) => {
            // Page Break if needed
            if (y > 750) {
                doc.addPage()
                y = 50
            }

            const premium = row.total_premium || 0
            totalPremium += premium

            const csrInfo = row.assigned_csr_profile
            const csrFullName = Array.isArray(csrInfo) 
                ? csrInfo[0]?.full_name 
                : csrInfo?.full_name

            doc.text(row.client_name?.substring(0, 20) || '-', colX.client, y)
            doc.text(row.policy_type?.substring(0, 20) || '-', colX.type, y)
            doc.text(`$${premium.toLocaleString()}`, colX.premium, y)
            doc.text(csrFullName?.substring(0, 15) || row.assigned_csr?.substring(0, 8) || '-', colX.csr, y)
            doc.text(row.renewal_date || (row.created_at ? row.created_at.split('T')[0] : '-'), colX.date, y)

            y += 20
        })

        doc.moveDown()
        doc.moveTo(30, y).lineTo(570, y).stroke()
        y += 10

        // Total
        doc.font('Helvetica-Bold').fontSize(12)
        doc.text(`Total Premium: $${totalPremium.toLocaleString()}`, colX.premium - 20, y)

        // End PDF
        doc.end()

        return new Response(readable, { headers })
    }

    return NextResponse.json(typedData)
}

