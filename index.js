const { query } = require('graphqurl');
const { head, isEmpty } = require('lodash');
const { robologin } = require('./robologin');

const HASURA_GRAPHQL_ENGINE_URL = process.env.HASURA_GRAPHQL_ENGINE_URL;

const GET_WORK_ORDER = `
    query GetWorkOrder($id: uuid!) {
        work_orders_by_pk(id:$id) {
            weight
            load_type {
                id
                code_name
            }
            order_type {
                initial_status_code_name
                code_name
                initial_status {
                    id
                }
            }
            unit_type {
                shortname
            }
            remark
            driver_moves: driver_moves_aggregate(where: {status_code: {_neq: "CANCELED"}}) {
                aggregate {
                    count
                }
            }
        }
    }
`;

const INSERT_DM = `
  mutation insert_driver_moves($data: [driver_moves_insert_input!]!) {
    insert_driver_moves(
      objects: $data
    ) {
      returning {
        id
      }
    }
  }
`;

const GET_WORKFLOW = `
query GetWorkflow {
    workflows(where: {workflow_config: {module: {code_name: {_eq: "DRIVER_MOVES"}}}, _and: {order: {_eq: "1"}}}) {
      id
      name
      order
      code_name
    }
  }

`;

// const GET_DM_TEMPLATE = `
// query DriverMoveTemplate($wo_from_id:uuid!, $wo_to_id:uuid!, $load_type_id:uuid!) {
//     driver_moves_templates(where: {wo_from_id: {_eq: $wo_from_id}, _and: {_and: {load_type_id: {_eq: $load_type_id}}, wo_to_id: {_eq: $wo_to_id}}}) {
//         load_type {
//             code_name
//         }
//         from_id
//         to_id
//         order
//         parent_routes_code_id
//         id
//       }
// }
// `;

const GET_INSPECTIONS = `
query GetInspections($type_code: String!) {
    inspections(where: {inspection_type: {code_name: {_eq: $type_code }}}) {
      id
    }
  }
`;

const UPDATE_WORK_ORDER_STATUS = `
mutation UpdateWorkOrderStatus($id: uuid!) {
    update_work_orders_by_pk(pk_columns:{id: $id}, _set: {
      status_code_name:"STARTED"
    }) {
      id
      status_code_name
      }
  }
`;

const GET_GLOBAL_CONFIG = `
  query global {
    item: global_config_by_pk(id: "613be2cf-409b-461d-a004-8bf500767fda") {
      settings
    }
  }
`;

const inspections = async (session_token) => {
    console.log(`Bearer ${session_token}`)
    const getInspections = await query({
        query: GET_INSPECTIONS,
        endpoint: HASURA_GRAPHQL_ENGINE_URL,
        variables: { type_code: "WORK_ORDERS" },
        headers: {
            'authorization': `Bearer ${session_token}`,
        }  
    });
    const { data: { inspections } } = getInspections;
    
    const newInspections = [];
    inspections.map(inspection => newInspections.push({ inspection_id: inspection.id }));
    return newInspections;
}

const dm_prefix = async (session_token) => {
    const getGlobalConfig = await query({
        query: GET_GLOBAL_CONFIG,
        endpoint: HASURA_GRAPHQL_ENGINE_URL,
        variables: {},
        headers: {
            'authorization': `Bearer ${session_token}`,
        }  
    });

    const { data: { item } } = getGlobalConfig;
    const dmPrefix = item.settings.find(
        setting => setting.name === 'dm_prefix',
    )
    console.log('dmPrefix', dmPrefix);
    return head(dmPrefix.settings).value;
}

const LB = 'LB';
const KG = 'KG';

exports.create_driver_moves_cf = async (req, res) => {
    const session_token = await robologin();
    console.log('session_token', session_token);
    console.log('HASURA_GRAPHQL_ENGINE_URL', HASURA_GRAPHQL_ENGINE_URL);

    const {
        event: {
            op,
            data,
            session_variables: {
                'x-hasura-role': x_hasura_role,
                'x-hasura-user-id': x_hasura_user_id,
                'x-hasura-organization-id': x_hasura_organization_id,
                'x-hasura-people-id': x_hasura_people_id,
                'x-hasura-people-full-name': x_hasura_people_full_name,
            },
        },
        table,
    } = req.body;
    console.log('x_hasura_organization_id', x_hasura_organization_id);
	if (
        (op === 'UPDATE' && table.name === 'work_orders' && table.schema === 'public') ||
        (op === 'INSERT' && table.name === 'work_orders' && table.schema === 'public' && (
            data.new.type_code_name === 'OTR' ||
            data.new.type_code_name === 'QUICK_DISPATCH' ||
            data.new.type_code_name === 'RAIL'
            ) && data.new.clone !== true
        ) ||
        (op === 'INSERT' && table.name === 'work_orders' && table.schema === 'public' && !isEmpty(data.new.last_free_day))
    ) {
        const { id: wo_id, from_id, from_zone_id, to_id, to_zone_id, id, equipment_id, eta,load_type_id, weight, customer_id, last_free_day, organization_id } = data.new;
        try {
            if ((from_id || from_zone_id) && (to_id || to_zone_id)) {
                const insertInspections = await inspections(session_token);
                const dmPrefix = await dm_prefix(session_token);

                const getWorkOrder = await query({
                    query: GET_WORK_ORDER,
                    endpoint: HASURA_GRAPHQL_ENGINE_URL,
                    variables: { id },
                    headers: {
                        'authorization': `Bearer ${session_token}`,
                    }  
                });
               const {
                    data: {
                        work_orders_by_pk: {
                            weight: wo_weight,
                            remark: remarks,
                            load_type: {
                                code_name: load_type_codename
                            },
                            order_type: {
                                code_name: order_type_codename,
                                initial_status: {
                                    id: initial_status_id
                                }
                            },
                            unit_type,
                            driver_moves: {
                                aggregate: {
                                    count
                                }
                            }
                        }
                    }
                } = getWorkOrder;
                if (count > 0) {
                    res.send(500, {error: "DM Already exists"});
                } else {
                    console.log('lfd: ', last_free_day);
                    console.log('from id: ', from_id);
                    let weightInLB;
                    if (unit_type && unit_type.shortname === KG) {
                        weightInLB = wo_weight*2.20;
                    }
                    else if (unit_type && unit_type.shortname === LB) {
                        weightInLB = wo_weight;
                    }
                    const getWorkflow = await query({
                        query: GET_WORKFLOW,
                        endpoint: HASURA_GRAPHQL_ENGINE_URL,
                        headers: {
                            'authorization': `Bearer ${session_token}`,
                        }  
                    });

                    const { data: { workflows: { 0 : { code_name: workflow_step_codename } }  } } = getWorkflow
                    // const getTemplate = await query({
                    //     query: GET_DM_TEMPLATE,
                    //     endpoint: HASURA_GRAPHQL_ENGINE_URL,
                    //     variables: { wo_from_id: from_id, wo_to_id: to_id,  load_type_id },
                    //     headers: {
                    //         'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
                    //     }  
                    // });
                    // const { data: { driver_moves_templates } } = getTemplate;

                    // if (driver_moves_templates.length > 0 ) {
                    //     console.log('Template');
                    //     driver_moves_templates.work_order_id = id;
                    //     let driverMoves = [];
                        
        
                    //     driver_moves_templates.map(driverMove => {
                    //         console.log('driverMove', driverMove);
                    //         const first_move = (driverMove.from_id === from_id);
                    //         let status_id, status_code;
                    //         if (first_move === true) {
                    //             status_id = initial_status_id;
                    //             status_code = initial_status_code_name;
                    //         } else {
                    //             status_code = 'DRAFT';
                    //         }
                            
                    //         const driverMoveObject = { 
                    //             from_id: driverMove.from_id, 
                    //             to_id: driverMove.to_id, 
                    //             weight:weightInLB,
                    //             customer_id,
                    //             arrival_date: eta,
                    //             equipment_id,
                    //             work_order_id: id,
                    //             load_type_codename: driverMove.load_type.code_name,
                    //             driver_move_template_id: driverMove.id,
                    //             last_free_day: last_free_day, 
                    //             first_move: true,
                    //             order: 1,
                    //             load_type_id,
                    //             status_id,
                    //             status_code,
                    //             parent_routes_code_id: driverMove.parent_routes_code_id,
                    //             folio: {
                    //                 data: {
                    //                     company_code_name: "BALI",
                    //                     prefix: "DM",
                    //                     service_type: "DRIVER_MOVES"
                    //                 }
                    //             },
                    //             workflow_step_codename,
                    //             order_type_codename,
                    //             inspection_logs: {
                    //                 data: insertInspections
                    //             }
                    //         };
                    //         //Hack nasty hack 🤮
                    //         if (driverMoveObject.order === 1) {
                    //             driverMoves.push(driverMoveObject);
                    //         }
                            
                    //     });
        
                    //     if (driver_moves_templates && driver_moves_templates.length > 0) {
                    //         const insertDriverMove = await query({
                    //             query: INSERT_DM,
                    //             endpoint: HASURA_GRAPHQL_ENGINE_URL,
                    //             variables: { data: driverMoves },
                    //             headers: {
                    //                 'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
                    //             }  
                    //         });
                    //         let updateWorkOrderStatus;
                    //         if (insertDriverMove) {
                    //             console.log('insering wo_id: ', wo_id);
                    //             updateWorkOrderStatus = await query({
                    //                 query: UPDATE_WORK_ORDER_STATUS,
                    //                 endpoint: HASURA_GRAPHQL_ENGINE_URL,
                    //                 variables: { id: wo_id },
                    //                 headers: {
                    //                     'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
                    //                 }  
                    //             });
                    //         }
                    //         res.send(200, { insertDriverMove, updateWorkOrderStatus });
                    //     }
                    // }
                    // else {

                    console.log('last_free_day for one: ', last_free_day);
                    const driverMoveObjectOne = { 
                        from_id: from_id, 
                        from_zone_id: from_zone_id, 
                        weight: weightInLB,
                        customer_id,
                        equipment_id,
                        work_order_id: id,
                        load_type_codename,
                        last_free_day, 
                        first_move: true,
                        order: 1,
                        // arrival_date: eta,
                        load_type_id,
                        status_id: initial_status_id,
                        status_code: 'AVAILABLE',
                        parent_routes_code_id: "f25170ef-f96e-4673-b0fd-087325e53b46",
                        parent_route_code_name: "LB-SD",
                        folio: {
                            data: {
                                company_code_name: "BALI",
                                prefix: dmPrefix,
                                service_type: "DRIVER_MOVES"
                            }
                        },
                        workflow_step_codename,
                        order_type_codename,
                        remarks,
                        organization_id: x_hasura_organization_id ||organization_id || null,
                    };

                    const insertDriverMoveOne = await query({
                        query: INSERT_DM,
                        endpoint: HASURA_GRAPHQL_ENGINE_URL,
                        variables: { data: [driverMoveObjectOne] },
                        headers: {
                            'authorization': `Bearer ${session_token}`,
                        }  
                    });

                    updateWorkOrderStatus = await query({
                        query: UPDATE_WORK_ORDER_STATUS,
                        endpoint: HASURA_GRAPHQL_ENGINE_URL,
                        variables: { id: wo_id },
                        headers: {
                            'authorization': `Bearer ${session_token}`,
                        }  
                    });

                    res.status(200).send({ message: "No template for this route, creating first driver move...",  insertDriverMoveOne});
                // }
                }
               
            } else {
                res.send(500, {error: "Must specify from_id and to_id"});
            }
        } catch (error) {
            console.log(error);
            res.send(500, error);
        }
        
    }
    else {
        res.status(200).send({ message: "I shouldn't be called" });
    }

    
    
};		